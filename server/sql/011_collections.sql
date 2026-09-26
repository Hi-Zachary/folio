-- Collections: a long-lived working scope across several documents (e.g. a course
-- or a project). They organise documents and act as a scope for asking questions.
CREATE TABLE collection (
  collection_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (collection_id),
  KEY idx_collection_owner (owner_id),
  CONSTRAINT fk_collection_owner FOREIGN KEY (owner_id) REFERENCES app_user(user_id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE collection_document (
  collection_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection_id, document_id),
  KEY idx_collection_document_document (document_id),
  CONSTRAINT fk_collection_document_collection FOREIGN KEY (collection_id) REFERENCES collection(collection_id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_document_document FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
