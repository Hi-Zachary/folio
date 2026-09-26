ALTER TABLE document_job
  MODIFY COLUMN job_type ENUM('parse', 'chunk', 'embedding', 'summary') NOT NULL;
