ALTER TABLE app_user
  ADD COLUMN password_hash VARCHAR(255) NULL,
  ADD COLUMN role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN last_login_at TIMESTAMP NULL,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS auth_session (
  session_id CHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  user_agent VARCHAR(512) NULL,
  ip_address VARCHAR(64) NULL,
  expires_at DATETIME NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_auth_session_token (token_hash),
  KEY idx_auth_session_user_expiry (user_id, expires_at),
  CONSTRAINT fk_auth_session_user FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE document_job
  ADD COLUMN locked_at TIMESTAMP NULL,
  ADD COLUMN locked_by VARCHAR(128) NULL;
