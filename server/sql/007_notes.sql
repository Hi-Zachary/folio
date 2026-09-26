-- Personal annotation layer: notes and highlights attach to a document (and
-- optionally to a specific chunk). Deleting a chunk keeps the note via SET NULL.
CREATE TABLE document_note (
  note_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  chunk_id BIGINT UNSIGNED NULL,
  quote VARCHAR(1000) NULL,
  content TEXT NOT NULL,
  color VARCHAR(20) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id),
  KEY idx_document_note_document (document_id),
  KEY idx_document_note_owner (owner_id),
  CONSTRAINT fk_document_note_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_document_note_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  CONSTRAINT fk_document_note_chunk FOREIGN KEY (chunk_id) REFERENCES document_chunk(chunk_id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
