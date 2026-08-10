ALTER TABLE models ADD COLUMN device_fit_base TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE models ADD COLUMN device_fit_pro TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS models_device_fit_base_idx
  ON models (device_fit_base, parameter_count, repo_id);

CREATE INDEX IF NOT EXISTS models_device_fit_pro_idx
  ON models (device_fit_pro, parameter_count, repo_id);
