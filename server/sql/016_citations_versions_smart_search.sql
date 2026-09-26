-- Citation verification state is calculated when an answer is persisted.
ALTER TABLE chat_message
  ADD COLUMN citation_status ENUM('verified', 'partial', 'missing', 'invalid') NOT NULL DEFAULT 'missing';

-- A smart collection stores a small, ownership-scoped document filter instead
-- of explicit collection_document rows.
ALTER TABLE collection
  ADD COLUMN is_smart BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN smart_filter JSON NULL;

CREATE TABLE saved_search (
  saved_search_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  query_text VARCHAR(255) NOT NULL DEFAULT '',
  filter_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_saved_search_owner_updated (owner_id, updated_at),
  CONSTRAINT fk_saved_search_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE document_version (
  version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  original_file_name VARCHAR(512) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  file_extension VARCHAR(32) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  file_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_document_version_no (document_id, version_no),
  KEY idx_document_version_document (document_id, version_no),
  CONSTRAINT fk_document_version_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE document_version_chunk (
  version_chunk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version_id BIGINT UNSIGNED NOT NULL,
  chunk_no INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  page_no INT UNSIGNED NULL,
  section_title VARCHAR(512) NULL,
  char_start INT UNSIGNED NULL,
  char_end INT UNSIGNED NULL,
  token_count INT UNSIGNED NULL,
  content_hash CHAR(64) NOT NULL,
  UNIQUE KEY uk_document_version_chunk_no (version_id, chunk_no),
  KEY idx_document_version_chunk_version (version_id),
  CONSTRAINT fk_document_version_chunk_version FOREIGN KEY (version_id) REFERENCES document_version(version_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
