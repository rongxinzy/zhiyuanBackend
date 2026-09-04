UPDATE plans
SET
  daily_request_limit = 100,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'guest';
