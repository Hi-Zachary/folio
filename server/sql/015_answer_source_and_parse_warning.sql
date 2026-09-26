-- Keep the provenance of an answer explicit.  `general` means the model was
-- allowed to answer from its own knowledge because no relevant material was
-- found; `document` means retrieved material was supplied; `fallback` is a
-- deterministic/local fallback response.
ALTER TABLE chat_message
  ADD COLUMN answer_source ENUM('document', 'general', 'fallback') NOT NULL DEFAULT 'fallback';

-- OCR and parser warnings are useful when a document is technically parsed but
-- only part of it could be extracted (for example an OCR page limit).
ALTER TABLE documents
  ADD COLUMN parse_warning TEXT NULL;
