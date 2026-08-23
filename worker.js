const REFRAME_SYSTEM_PROMPT = `
あなたは、日記を書いた人が出来事を少し違う角度から見られるよう手伝う相手です。

ルール
・リフレーミングとは、
ネガティブをポジティブに言い換えることではありません。

ユーザーが気付いていない別の解釈や、
出来事を見る新しい視点を一つだけ提案してください。

無理に前向きな結論にしないでください。
・リフレーミングでは、「他人はこうだから」「誰でもそう」「時間が解決する」といった一般論で励ましてはいけません。

日記の中に書かれている出来事・感情・行動だけを根拠に、新しい見方を提案してください。

提案は「なるほど、その見方もあるかもしれない」と思える範囲に留め、根拠のない推測や過度な美化はしないでください。
・共感だけで終わらない
・説教しない
・無理にポジティブにしない
・自然な日本語で話す
・日常会話で使わない難しい言葉は使わない
・「危機管理能力」「リソース」「データ」などAIらしい表現は禁止
・毎回まったく同じ言い回しや構成にならないようにしてください。
・「別の見方」「今日の学び」「明日やってみること」の内容や表現に適度な変化をつけてください。
・他人を引き合いに出して励まさないでください。

「みんなも悩んでいる」
「誰にでもある」
「時間が解決する」
「きっと大丈夫」

のような一般論は使わないでください。

ユーザー自身の日記に書かれている内容だけを材料にして、
新しい視点を提案してください。

・悪い例
周りの人も悩んでいます。
誰にでもあることです。
きっと大丈夫です。

このような一般論は書かないでください。

出力形式

💡 別の見方
出来事を別の角度から80〜120文字程度で。

🌱 今日の学び
30〜50文字程度。

✨ 明日やってみること
一文だけ。

全体で180〜250文字程度に収めてください。

回答例

💡 別の見方
ミスをしたことは残念でしたが、早めに気付けたことで大きな問題にはなりませんでした。周りが助けてくれたことから、一人で抱え込まなくていい環境だと分かった日でもあります。

🌱 今日の学び
確認を少し増やすだけでも次につながります。

✨ 明日やってみること
一つだけ確認項目を増やしてみましょう。
`;

// =====================================================================
// CORS設定
//   - CORSは「どのサイトのブラウザJSからこのWorkerを呼べるか」だけを制御する。
//     日記データへのアクセス許可(本人確認)は別途トークン検証で行う。
//   - 本番の公開URLは環境変数 ALLOWED_ORIGINS（カンマ区切り）で管理する。
//   - 開発中は localhost / 127.0.0.1 / file://(Origin: "null") を自動的に許可する。
// =====================================================================
function isOriginAllowed(origin, env) {
  if (!origin) return false;
  if (origin === 'null') return true; // file:// で直接開いた場合の開発用
  try {
    const { hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true; // ローカル開発サーバー
  } catch (e) {
    // Origin ヘッダーがURLとして不正な場合は許可しない
  }
  const configured = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return configured.includes(origin);
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Diary-Token',
    'Vary': 'Origin',
  };
  if (isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const url = new URL(request.url);

    // ---- Phase 1: Cloudflare D1への自動バックアップ ----
    if (url.pathname === '/sync') {
      return handleSync(request, env, cors);
    }

    // ---- Phase 4: Cloudflare D1からの復元(読み取り専用) ----
    if (url.pathname === '/restore') {
      return handleRestore(request, env, cors);
    }

    // ---- 既存機能：Gemini APIへの中継（リフレーミング／じぶんを見つめる分析） ----
    try {
      const { text, prompt } = await request.json();

      let finalPrompt;
      if (text) {
        finalPrompt = `${REFRAME_SYSTEM_PROMPT}\n\n---\n【ユーザーの日記】\n${text}`;
      } else if (prompt) {
        finalPrompt = prompt;
      } else {
        return new Response(JSON.stringify({ error: 'text または prompt が必要です' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: finalPrompt }] }],
            generationConfig: { maxOutputTokens: 500 },
          }),
        }
      );
      const data = await res.json();
      return new Response(JSON.stringify(data), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  },
};

// 匿名ID・秘密トークンによる自動バックアップ処理。
// ・匿名IDだけでは書き込みを許可しない（秘密トークンのハッシュが一致して初めて許可）
// ・初回アクセス時のみ、そのトークンを「このIDの正規トークン」として自動登録する(TOFU方式)
// ・CORSはここでは一切関与しない。本人確認は完全にこの関数の中で行う
// ・現時点では日記データは暗号化された状態で受け取り、そのまま保存する(Workerは復号しない)
async function handleSync(request, env, cors) {
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'sync not configured' }), { status: 503, headers: jsonHeaders });
    }

    const token = request.headers.get('X-Diary-Token');
    if (!token || token.length < 32) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: jsonHeaders });
    }

    const body = await request.json();
    const anonId = body && body.anonId;
    const entries = body && body.entries;
    const settings = body && body.settings;
    if (!anonId || typeof anonId !== 'string' || !Array.isArray(entries)) {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400, headers: jsonHeaders });
    }

    const tokenHash = await sha256Hex(token);
    // settings は {v, iv, cipher} という暗号化済みオブジェクトが届く。Workerはこれも中身を理解せず保存するだけ。
    const settingsJson = settings ? JSON.stringify(settings) : null;

    const userRow = await env.DB.prepare('SELECT token_hash FROM users WHERE anon_id = ?').bind(anonId).first();
    if (!userRow) {
      // 書き込み系エンドポイントなので、初回だけは自動登録してよい(TOFU方式)
      await env.DB.prepare('INSERT INTO users (anon_id, token_hash, created_at, settings_json) VALUES (?, ?, ?, ?)')
        .bind(anonId, tokenHash, Date.now(), settingsJson)
        .run();
    } else if (userRow.token_hash !== tokenHash) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: jsonHeaders });
    } else if (settingsJson) {
      await env.DB.prepare('UPDATE users SET settings_json = ? WHERE anon_id = ?').bind(settingsJson, anonId).run();
    }

    // 「丸ごと洗い替え」方式：この匿名IDの既存行を消し、送られてきた最新のentries全体を入れ直す
    const now = Date.now();
    const statements = [env.DB.prepare('DELETE FROM entries WHERE anon_id = ?').bind(anonId)];
    for (const e of entries) {
      if (!e || !e.id || !e.encrypted) continue;
      statements.push(
        env.DB.prepare(
          'INSERT INTO entries (anon_id, entry_id, is_hidden, created_at, updated_at, content_json) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(anonId, String(e.id), 0, now, now, JSON.stringify(e.encrypted))
      );
    }
    await env.DB.batch(statements);

    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  } catch (e) {
    console.error('sync failed');
    return new Response(JSON.stringify({ error: 'sync failed' }), { status: 500, headers: jsonHeaders });
  }
}

// Cloudflare D1からの復元(読み取り専用)。
// /sync とは違い、未登録のanonIdに対して自動登録は行わない（読み取り専用エンドポイントに
// 書き込み的な副作用を持たせないため）。該当データが無ければ404を返すだけ。
// トークンのハッシュ照合ロジック自体は /sync と共通(sha256Hex)で、認証の強度は同じ。
// Workerはここでも一切復号しない。暗号文をそのままブラウザへ返すだけ。
async function handleRestore(request, env, cors) {
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' };
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'restore not configured' }), { status: 503, headers: jsonHeaders });
    }

    const token = request.headers.get('X-Diary-Token');
    if (!token || token.length < 32) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: jsonHeaders });
    }

    const body = await request.json();
    const anonId = body && body.anonId;
    if (!anonId || typeof anonId !== 'string') {
      return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400, headers: jsonHeaders });
    }

    const tokenHash = await sha256Hex(token);

    const userRow = await env.DB.prepare('SELECT token_hash, settings_json FROM users WHERE anon_id = ?').bind(anonId).first();
    if (!userRow) {
      // 復元は読み取り専用。未登録のIDを勝手に作ったりはしない。単に「復元対象なし」として扱う
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: jsonHeaders });
    }
    if (userRow.token_hash !== tokenHash) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: jsonHeaders });
    }

    const rows = await env.DB.prepare('SELECT entry_id, content_json FROM entries WHERE anon_id = ?').bind(anonId).all();
    const entries = (rows.results || []).map(r => ({
      id: r.entry_id,
      encrypted: JSON.parse(r.content_json),
    }));
    const settings = userRow.settings_json ? JSON.parse(userRow.settings_json) : null;

    return new Response(JSON.stringify({ entries, settings }), { headers: jsonHeaders });
  } catch (e) {
    console.error('restore failed');
    return new Response(JSON.stringify({ error: 'restore failed' }), { status: 500, headers: jsonHeaders });
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
