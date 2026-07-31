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
//     日記データへのアクセス許可(本人確認)は別途 handleSync 内のトークン検証で行う。
//   - 本番の公開URLはまだ決まっていないため、コードに直接書かない。
//     Worker の環境変数 ALLOWED_ORIGINS（カンマ区切り）で管理する。
//     例: "https://your-name.github.io,https://diary.example.com"
//   - 開発中は localhost / 127.0.0.1 / file://(Origin: "null") を自動的に許可する。
//     これらは開発用の既定許可であり、ALLOWED_ORIGINS の設定は不要。
// =====================================================================
function isOriginAllowed(origin, env) {
  if (!origin) return false;
  if (origin === 'null') return true; // diary-app.html を file:// で直接開いた場合
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
  // 許可されていないOriginの場合、Access-Control-Allow-Originを付けない。
  // これによりブラウザ側でCORSエラーとして扱われ、レスポンスは読み取れなくなる。
  return headers;
}

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      // プリフライトリクエストへの応答
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
// ・以後、同じIDに別のトークンで書き込もうとした場合は拒否する
// ・CORSはここでは一切関与しない。本人確認は完全にこの関数の中で行う
// ・現時点(Phase 1)では日記データは平文のまま保存される。暗号化はPhase 3で別途対応する
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
    // settings も Phase 3 からは {v, iv, cipher} という暗号化済みオブジェクトが届く。
    // Workerはこれも中身を理解せず、そのままJSON文字列として保存するだけ。
    const settingsJson = settings ? JSON.stringify(settings) : null;

    const userRow = await env.DB.prepare('SELECT token_hash FROM users WHERE anon_id = ?').bind(anonId).first();
    if (!userRow) {
      await env.DB.prepare('INSERT INTO users (anon_id, token_hash, created_at, settings_json) VALUES (?, ?, ?, ?)')
        .bind(anonId, tokenHash, Date.now(), settingsJson)
        .run();
    } else if (userRow.token_hash !== tokenHash) {
      // 匿名IDは合っていても、秘密トークンが一致しないため書き込みを拒否
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: jsonHeaders });
    } else if (settingsJson) {
      await env.DB.prepare('UPDATE users SET settings_json = ? WHERE anon_id = ?').bind(settingsJson, anonId).run();
    }

    // Phase 3: entries は [{ id, encrypted: {v, iv, cipher} }] という暗号化済みの形で届く。
    // Workerは中身を一切理解・復号せず、そのままD1へ保存するだけ。
    // is_hidden・作成日時も暗号文の中にしかないため、D1側の列には意味のある値を入れない
    // （is_hiddenは常に0、created_at/updated_atはD1に書き込んだ時刻）。
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
    // Workerのログにも秘密トークンや個々の日記内容は出さない
    console.error('sync failed');
    return new Response(JSON.stringify({ error: 'sync failed' }), { status: 500, headers: jsonHeaders });
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
