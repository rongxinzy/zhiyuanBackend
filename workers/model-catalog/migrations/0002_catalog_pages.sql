CREATE TABLE IF NOT EXISTS catalog_pages (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  stale_after TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS catalog_pages_stale_idx ON catalog_pages (stale_after);
