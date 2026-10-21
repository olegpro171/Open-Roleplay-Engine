-- NULL preserves the distinction between an unknown historical date and a new record.
ALTER TABLE library ADD COLUMN created_at TEXT;
ALTER TABLE library ADD COLUMN updated_at TEXT;
ALTER TABLE connections ADD COLUMN created_at TEXT;
ALTER TABLE connections ADD COLUMN updated_at TEXT;
ALTER TABLE chats ADD COLUMN created_at TEXT;
ALTER TABLE chats ADD COLUMN updated_at TEXT;
ALTER TABLE turns ADD COLUMN message_at TEXT;

-- Existing generation records can establish message activity, but not creation dates.
UPDATE turns SET message_at = completed.message_at
FROM (
  SELECT turn_id, MAX(updated_at) AS message_at FROM generations
  WHERE status = 'succeeded' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  GROUP BY turn_id
) AS completed
WHERE turns.id = completed.turn_id;
CREATE INDEX turn_message_date ON turns(chat_id, message_at);
