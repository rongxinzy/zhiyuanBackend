PRAGMA foreign_keys = ON;

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  daily_request_limit INTEGER CHECK (daily_request_limit IS NULL OR daily_request_limit >= 0),
  daily_token_limit INTEGER CHECK (daily_token_limit IS NULL OR daily_token_limit >= 0),
  monthly_token_limit INTEGER CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'disabled')),
  plan_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX idx_users_plan_id ON users(plan_id);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE logical_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entitlements (
  user_id TEXT NOT NULL,
  logical_model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, logical_model_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (logical_model_id) REFERENCES logical_models(id) ON DELETE CASCADE
);

CREATE INDEX idx_entitlements_model_enabled
  ON entitlements(logical_model_id, enabled);
CREATE INDEX idx_entitlements_expiry
  ON entitlements(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE route_mappings (
  logical_model_id TEXT PRIMARY KEY,
  openai_route TEXT,
  anthropic_route TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (logical_model_id) REFERENCES logical_models(id) ON DELETE CASCADE,
  CHECK (openai_route IS NOT NULL OR anthropic_route IS NOT NULL)
);

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  logical_model_id TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, usage_date, logical_model_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (logical_model_id) REFERENCES logical_models(id)
);

CREATE INDEX idx_usage_daily_date_model
  ON usage_daily(usage_date, logical_model_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_actor_created ON audit_logs(actor_id, created_at DESC);

INSERT INTO logical_models (id, name, description, enabled)
VALUES (
  'zhiyuan-free',
  'zhiyuan-free',
  'Default free model selected from the current qualified agent pool.',
  0
);
