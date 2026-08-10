CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unknown')),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'expired', 'locked')),
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  resend_message_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER,
  verified_at INTEGER
);

CREATE INDEX idx_email_challenges_email_created
  ON email_challenges (email_hash, created_at DESC);

CREATE INDEX idx_email_challenges_expiry
  ON email_challenges (expires_at);
