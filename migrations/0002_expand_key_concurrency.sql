PRAGMA foreign_keys = OFF;

CREATE TABLE anysearch_keys_next (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooldown', 'exhausted', 'disabled')),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 50),
  cooldown_until INTEGER,
  last_selected_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO anysearch_keys_next SELECT * FROM anysearch_keys;
DROP TABLE anysearch_keys;
ALTER TABLE anysearch_keys_next RENAME TO anysearch_keys;
CREATE INDEX idx_anysearch_keys_available ON anysearch_keys(status, cooldown_until, last_selected_at);

PRAGMA foreign_keys = ON;
