-- Rolling conversation memory: older turns are folded into a summary so long
-- chats keep resolving references without resending the whole history.
ALTER TABLE chat_session
  ADD COLUMN summary LONGTEXT NULL,
  ADD COLUMN summarized_until_message_id BIGINT UNSIGNED NULL;
