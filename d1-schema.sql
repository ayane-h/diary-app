-- Cloudflare D1 ダッシュボードの「Console」タブに貼り付けて実行してください。

-- ============================================================
-- Phase 1ですでにテーブルを作成済みの場合は、こちらの1行だけ実行してください。
-- （Phase 2でタグ・テーマ・PIN設定などもバックアップ対象に含めるための追加列です）
-- ============================================================
ALTER TABLE users ADD COLUMN settings_json TEXT;

-- ============================================================
-- これから初めてD1を構築する場合は、上のALTER文の代わりに以下をすべて実行してください。
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  anon_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settings_json TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  anon_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY (anon_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_anon_id ON entries (anon_id);

