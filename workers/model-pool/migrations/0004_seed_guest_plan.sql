INSERT INTO plans (
  id,
  name,
  daily_request_limit,
  daily_token_limit,
  monthly_token_limit
)
VALUES (
  'guest',
  'GUEST',
  10,
  20000,
  100000
)
ON CONFLICT(id) DO UPDATE SET
  daily_request_limit = excluded.daily_request_limit,
  daily_token_limit = excluded.daily_token_limit,
  monthly_token_limit = excluded.monthly_token_limit,
  updated_at = CURRENT_TIMESTAMP;
