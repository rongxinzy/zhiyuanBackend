CREATE TABLE IF NOT EXISTS anysearch_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooldown', 'exhausted', 'disabled')),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 10),
  cooldown_until INTEGER,
  last_selected_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anysearch_keys_available
  ON anysearch_keys(status, cooldown_until, last_selected_at);

CREATE TABLE IF NOT EXISTS anysearch_key_slots (
  key_id TEXT NOT NULL REFERENCES anysearch_keys(id) ON DELETE CASCADE,
  slot_no INTEGER NOT NULL,
  lease_id TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (key_id, slot_no)
);

CREATE INDEX IF NOT EXISTS idx_anysearch_slots_lease
  ON anysearch_key_slots(lease_expires_at);

CREATE TABLE IF NOT EXISTS anysearch_daily_usage (
  key_id TEXT NOT NULL REFERENCES anysearch_keys(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, usage_date)
);
