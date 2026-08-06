UPDATE models
SET
  model_json = json_remove(
    model_json,
    '$.parameterCount',
    '$.metadataStatus',
    '$.parameter_count',
    '$.parameter_count_known',
    '$.metadata_status'
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_valid(model_json) = 1
  AND (
    json_type(model_json, '$.parameterCount') IS NOT NULL
    OR json_type(model_json, '$.metadataStatus') IS NOT NULL
    OR json_type(model_json, '$.parameter_count') IS NOT NULL
    OR json_type(model_json, '$.parameter_count_known') IS NOT NULL
    OR json_type(model_json, '$.metadata_status') IS NOT NULL
  );
