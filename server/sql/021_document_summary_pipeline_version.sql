ALTER TABLE documents
  ADD COLUMN ai_summary_pipeline_version INT NOT NULL DEFAULT 0;

CREATE TABLE document_summary_section (
  section_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  content_version INT NOT NULL,
  section_no INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary MEDIUMTEXT NOT NULL,
  start_chunk_no INT NOT NULL,
  end_chunk_no INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (section_id),
  UNIQUE KEY uq_document_summary_section (document_id, content_version, section_no),
  KEY idx_summary_section_version (document_id, content_version),
  CONSTRAINT fk_summary_section_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
