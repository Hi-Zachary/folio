-- Document-level AI summary (a per-document reading aid, not a standalone module).
-- content_version lets us tell whether a cached summary is stale after a re-parse.
ALTER TABLE documents
  ADD COLUMN content_version INT NOT NULL DEFAULT 1,
  ADD COLUMN ai_summary TEXT NULL,
  ADD COLUMN ai_summary_key_points JSON NULL,
  ADD COLUMN ai_summary_outline JSON NULL,
  ADD COLUMN ai_summary_model VARCHAR(255) NULL,
  ADD COLUMN ai_summary_at DATETIME NULL,
  ADD COLUMN ai_summary_version INT NULL;
