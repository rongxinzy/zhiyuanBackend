UPDATE models
SET model_json = CASE
  WHEN parameter_count IS NULL THEN
    json_set(model_json, '$.metadataStatus', metadata_status)
  ELSE
    json_set(
      json_set(model_json, '$.parameterCount', parameter_count),
      '$.metadataStatus',
      metadata_status
    )
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_valid(model_json) = 1;
