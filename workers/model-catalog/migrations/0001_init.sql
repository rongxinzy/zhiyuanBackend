CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  sizes_json TEXT NOT NULL DEFAULT '[]',
  capability_json TEXT NOT NULL DEFAULT '[]',
  model_json TEXT NOT NULL,
  downloads REAL,
  quality_score REAL,
  trust_score REAL,
  community_score REAL,
  featured INTEGER NOT NULL DEFAULT 0,
  featured_rank INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS models_featured_idx ON models (featured, featured_rank);
CREATE INDEX IF NOT EXISTS models_updated_idx ON models (updated_at);

CREATE TABLE IF NOT EXISTS model_files (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  quantization TEXT,
  is_recommended INTEGER NOT NULL DEFAULT 0,
  download_url TEXT,
  PRIMARY KEY (model_id, path)
);

CREATE INDEX IF NOT EXISTS model_files_quant_idx ON model_files (quantization);

CREATE TABLE IF NOT EXISTS model_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  rating REAL,
  device_class TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS model_feedback_model_idx ON model_feedback (model_id, created_at);

CREATE TABLE IF NOT EXISTS modelscope_pool_tokens (
  token_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  cooldown_until TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modelscope_token_leases (
  token_id TEXT PRIMARY KEY REFERENCES modelscope_pool_tokens(token_id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  leased_until TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS models_fts USING fts5(
  repo_id UNINDEXED,
  name,
  description,
  tags,
  capability,
  content='models',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS models_ai AFTER INSERT ON models BEGIN
  INSERT INTO models_fts(rowid, repo_id, name, description, tags, capability)
  VALUES (new.rowid, new.repo_id, new.name, new.description, new.tags_json, new.capability_json);
END;

CREATE TRIGGER IF NOT EXISTS models_ad AFTER DELETE ON models BEGIN
  INSERT INTO models_fts(models_fts, rowid, repo_id, name, description, tags, capability)
  VALUES ('delete', old.rowid, old.repo_id, old.name, old.description, old.tags_json, old.capability_json);
END;

CREATE TRIGGER IF NOT EXISTS models_au AFTER UPDATE ON models BEGIN
  INSERT INTO models_fts(models_fts, rowid, repo_id, name, description, tags, capability)
  VALUES ('delete', old.rowid, old.repo_id, old.name, old.description, old.tags_json, old.capability_json);
  INSERT INTO models_fts(rowid, repo_id, name, description, tags, capability)
  VALUES (new.rowid, new.repo_id, new.name, new.description, new.tags_json, new.capability_json);
END;
