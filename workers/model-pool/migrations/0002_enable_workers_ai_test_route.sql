UPDATE logical_models
SET enabled = 1, updated_at = CURRENT_TIMESTAMP
WHERE id = 'zhiyuan-free';

INSERT INTO route_mappings (
  logical_model_id,
  openai_route,
  anthropic_route,
  enabled
)
VALUES (
  'zhiyuan-free',
  'default',
  NULL,
  1
)
ON CONFLICT(logical_model_id) DO UPDATE SET
  openai_route = excluded.openai_route,
  anthropic_route = excluded.anthropic_route,
  enabled = excluded.enabled,
  updated_at = CURRENT_TIMESTAMP;
