-- Keep answer citations readable even after a document is re-parsed or deleted:
-- store the document metadata on the source row and let chunk_id become NULL
-- instead of cascading the source away.
ALTER TABLE message_source
  ADD COLUMN document_id BIGINT UNSIGNED NULL,
  ADD COLUMN document_name VARCHAR(512) NULL,
  ADD COLUMN file_extension VARCHAR(32) NULL;

ALTER TABLE message_source DROP FOREIGN KEY fk_message_source_chunk;
ALTER TABLE message_source MODIFY COLUMN chunk_id BIGINT UNSIGNED NULL;
ALTER TABLE message_source
  ADD CONSTRAINT fk_message_source_chunk FOREIGN KEY (chunk_id) REFERENCES document_chunk(chunk_id) ON DELETE SET NULL;

UPDATE message_source ms
  INNER JOIN document_chunk c ON c.chunk_id = ms.chunk_id
  INNER JOIN documents d ON d.document_id = c.document_id
SET ms.document_id = d.document_id,
    ms.document_name = d.original_file_name,
    ms.file_extension = d.file_extension
WHERE ms.document_id IS NULL;

-- Categories can be shared (owner_id NULL, seeded defaults) or owned by a user.
ALTER TABLE document_category
  ADD COLUMN owner_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_document_category_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id) ON DELETE CASCADE;

ALTER TABLE document_category DROP INDEX uk_document_category_name;
ALTER TABLE document_category ADD UNIQUE KEY uk_document_category_owner_name (owner_id, category_name);
