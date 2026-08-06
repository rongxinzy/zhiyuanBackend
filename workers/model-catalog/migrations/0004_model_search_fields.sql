ALTER TABLE models ADD COLUMN parameter_count REAL;
ALTER TABLE models ADD COLUMN parameter_count_known INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'verified';

UPDATE models
SET
  parameter_count = CASE
    WHEN json_valid(model_json) = 1
      AND json_type(model_json, '$.parameterCount') IN ('integer', 'real')
    THEN CAST(json_extract(model_json, '$.parameterCount') AS REAL)
    ELSE NULL
  END,
  parameter_count_known = CASE
    WHEN json_valid(model_json) = 1
      AND json_type(model_json, '$.parameterCount') IN ('integer', 'real')
    THEN 1
    ELSE 0
  END,
  metadata_status = CASE
    WHEN json_valid(model_json) = 1
      AND json_extract(model_json, '$.metadataStatus') IN ('verified', 'pending', 'unavailable')
    THEN json_extract(model_json, '$.metadataStatus')
    ELSE 'verified'
  END;
