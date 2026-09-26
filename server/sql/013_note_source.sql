-- A note can be hand-written, an excerpt from a document, or saved from an AI answer.
ALTER TABLE document_note
  ADD COLUMN source_type ENUM('manual', 'excerpt', 'chat') NOT NULL DEFAULT 'manual',
  ADD COLUMN source_message_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_document_note_message FOREIGN KEY (source_message_id) REFERENCES chat_message(message_id) ON DELETE SET NULL;
