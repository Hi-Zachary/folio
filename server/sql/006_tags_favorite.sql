-- Personal knowledge base organisation: per-user tags, document<->tag links,
-- and a favourite flag. All additive.
CREATE TABLE tag (
  tag_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(20) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tag_id),
  UNIQUE KEY uk_tag_owner_name (owner_id, name),
  CONSTRAINT fk_tag_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE document_tag (
  document_id BIGINT UNSIGNED NOT NULL,
  tag_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, tag_id),
  KEY idx_document_tag_tag (tag_id),
  CONSTRAINT fk_document_tag_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
  CONSTRAINT fk_document_tag_tag FOREIGN KEY (tag_id) REFERENCES tag(tag_id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

ALTER TABLE documents ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE;
