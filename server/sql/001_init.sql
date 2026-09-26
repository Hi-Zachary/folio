CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_user (
  user_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_category (
  category_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_document_category_name (category_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS documents (
  document_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  original_file_name VARCHAR(512) NOT NULL,
  stored_file_name VARCHAR(512) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  file_extension VARCHAR(32) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  file_hash CHAR(64) NOT NULL,
  parse_status ENUM('pending', 'parsing', 'parsed', 'failed') NOT NULL DEFAULT 'pending',
  parse_error TEXT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  parsed_at TIMESTAMP NULL,
  indexed_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_documents_owner_hash (owner_id, file_hash),
  KEY idx_documents_owner_status (owner_id, parse_status, deleted_at),
  KEY idx_documents_category (category_id),
  CONSTRAINT fk_documents_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id),
  CONSTRAINT fk_documents_category FOREIGN KEY (category_id) REFERENCES document_category(category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_job (
  job_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  job_type ENUM('parse', 'chunk', 'embedding') NOT NULL,
  status ENUM('pending', 'running', 'success', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_document_job_document (document_id, job_type, created_at),
  CONSTRAINT fk_document_job_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS document_chunk (
  chunk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  chunk_no INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  page_no INT UNSIGNED NULL,
  section_title VARCHAR(512) NULL,
  char_start INT UNSIGNED NULL,
  char_end INT UNSIGNED NULL,
  token_count INT UNSIGNED NULL,
  content_hash CHAR(64) NOT NULL,
  embedding_status ENUM('pending', 'running', 'success', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
  embedding_model VARCHAR(255) NULL,
  embedding_json JSON NULL,
  vector_collection VARCHAR(255) NULL,
  vector_id VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_document_chunk_no (document_id, chunk_no),
  KEY idx_document_chunk_document (document_id),
  FULLTEXT KEY ft_document_chunk_content (content),
  CONSTRAINT fk_document_chunk_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_session (
  session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '新会话',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_chat_session_owner_updated (owner_id, updated_at),
  CONSTRAINT fk_chat_session_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_message (
  message_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  role ENUM('system', 'user', 'assistant', 'tool') NOT NULL,
  content LONGTEXT NOT NULL,
  no_match BOOLEAN NOT NULL DEFAULT FALSE,
  message_status ENUM('pending', 'complete', 'error') NOT NULL DEFAULT 'complete',
  model_name VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_chat_message_session_created (session_id, created_at),
  CONSTRAINT fk_chat_message_session FOREIGN KEY (session_id) REFERENCES chat_session(session_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_retrieval (
  retrieval_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  chunk_id BIGINT UNSIGNED NOT NULL,
  rank_no INT UNSIGNED NOT NULL,
  similarity_score DECIMAL(10, 6) NOT NULL DEFAULT 0,
  retrieval_method VARCHAR(64) NOT NULL,
  selected_for_context BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_message_retrieval_message (message_id, rank_no),
  CONSTRAINT fk_message_retrieval_message FOREIGN KEY (message_id) REFERENCES chat_message(message_id) ON DELETE CASCADE,
  CONSTRAINT fk_message_retrieval_chunk FOREIGN KEY (chunk_id) REFERENCES document_chunk(chunk_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_source (
  source_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  chunk_id BIGINT UNSIGNED NOT NULL,
  source_order INT UNSIGNED NOT NULL,
  snippet TEXT NOT NULL,
  page_no INT UNSIGNED NULL,
  section_title VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_message_source_message (message_id, source_order),
  CONSTRAINT fk_message_source_message FOREIGN KEY (message_id) REFERENCES chat_message(message_id) ON DELETE CASCADE,
  CONSTRAINT fk_message_source_chunk FOREIGN KEY (chunk_id) REFERENCES document_chunk(chunk_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study_generation (
  generation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'running', 'success', 'failed') NOT NULL DEFAULT 'pending',
  summary LONGTEXT NULL,
  key_points JSON NULL,
  outline JSON NULL,
  model_name VARCHAR(255) NULL,
  generation_no INT UNSIGNED NOT NULL DEFAULT 1,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  KEY idx_study_generation_document (document_id, created_at),
  CONSTRAINT fk_study_generation_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id),
  CONSTRAINT fk_study_generation_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
