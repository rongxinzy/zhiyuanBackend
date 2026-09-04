INSERT INTO plans (
  id,
  name,
  daily_request_limit,
  daily_token_limit,
  monthly_token_limit
)
VALUES (
  'free',
  'FREE',
  100,
  100000,
  3000000
)
ON CONFLICT(id) DO UPDATE SET
  daily_request_limit = excluded.daily_request_limit,
  daily_token_limit = excluded.daily_token_limit,
  monthly_token_limit = excluded.monthly_token_limit,
  updated_at = CURRENT_TIMESTAMP;

UPDATE route_mappings
SET
  openai_route = 'free-agent-openai',
  updated_at = CURRENT_TIMESTAMP
WHERE logical_model_id = 'zhiyuan-free';
