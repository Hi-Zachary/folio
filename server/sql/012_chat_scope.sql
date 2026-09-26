-- Question scope: library (all docs) / collection / explicit documents.
-- The session holds the current default; each user message snapshots the scope
-- actually used, so history stays explainable after the scope changes.
ALTER TABLE chat_session
  ADD COLUMN scope_type ENUM('library', 'collection', 'documents') NOT NULL DEFAULT 'library',
  ADD COLUMN scope_collection_id BIGINT UNSIGNED NULL,
  ADD COLUMN scope_document_ids JSON NULL;

ALTER TABLE chat_message
  ADD COLUMN scope_snapshot JSON NULL;
