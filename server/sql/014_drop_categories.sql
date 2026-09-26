-- Organisation was simplified: "collection" (multi, doubles as a question scope)
-- and "tag" (multi, attributes) are enough. The single-choice "category" layer
-- only duplicated them and forced a choice at upload time.
ALTER TABLE documents DROP FOREIGN KEY fk_documents_category;
ALTER TABLE documents DROP COLUMN category_id;
DROP TABLE IF EXISTS document_category;
