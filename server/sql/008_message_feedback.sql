-- User feedback on an answer: 1 = helpful, -1 = not helpful.
ALTER TABLE chat_message ADD COLUMN feedback TINYINT NULL;
