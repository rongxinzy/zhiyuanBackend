CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE authorization_requests (
  id TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  authorization_code_digest TEXT,
  authorization_code_expires_at INTEGER,
  authorization_code_used_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE email_challenges ADD COLUMN authorization_request_id TEXT REFERENCES authorization_requests(id);

CREATE INDEX idx_authorization_requests_expiry ON authorization_requests (expires_at);
CREATE INDEX idx_authorization_requests_code ON authorization_requests (authorization_code_expires_at);

CREATE TABLE refresh_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_digest TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_refresh_sessions_expiry ON refresh_sessions (expires_at);
