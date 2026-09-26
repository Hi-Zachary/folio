-- MariaDB/MySQL implicitly adds `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
-- to the first TIMESTAMP column of a table when it is declared without an explicit
-- DEFAULT. That made `expires_at` get reset to NOW() on every `UPDATE auth_session`
-- (e.g. the `last_seen_at` touch in currentUser), so sessions expired immediately.
-- DATETIME has no such implicit behaviour.
ALTER TABLE auth_session
  MODIFY COLUMN expires_at DATETIME NOT NULL;
