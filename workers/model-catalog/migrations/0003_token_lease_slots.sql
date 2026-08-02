CREATE TABLE IF NOT EXISTS modelscope_token_lease_slots (
  token_id TEXT NOT NULL REFERENCES modelscope_pool_tokens(token_id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 2),
  lease_id TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  PRIMARY KEY (token_id, slot)
);

CREATE INDEX IF NOT EXISTS modelscope_token_lease_slots_expiry_idx
  ON modelscope_token_lease_slots (leased_until);
