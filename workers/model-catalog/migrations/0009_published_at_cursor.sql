ALTER TABLE models ADD COLUMN published_at TEXT;

-- Catalog values are canonical ISO 8601 UTC timestamps, so lexical DESC
-- order is chronological DESC order. Rows without an authoritative upstream
-- creation time sort after timestamped rows within the same parameter count.
CREATE INDEX IF NOT EXISTS models_catalog_parameter_published_idx
  ON models (
    parameter_count_known DESC,
    parameter_count ASC,
    published_at DESC,
    repo_id ASC
  );
