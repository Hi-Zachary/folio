-- Citation markers stay as the simple user-facing [1] format. Verification
-- metadata was removed because the useful interaction is opening the source
-- context, not showing an internal citation score.
ALTER TABLE chat_message DROP COLUMN citation_status;
