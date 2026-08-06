CREATE INDEX IF NOT EXISTS models_parameter_asc_idx
  ON models (parameter_count_known DESC, parameter_count ASC, repo_id ASC);

CREATE INDEX IF NOT EXISTS models_parameter_desc_idx
  ON models (parameter_count_known DESC, parameter_count DESC, repo_id ASC);
