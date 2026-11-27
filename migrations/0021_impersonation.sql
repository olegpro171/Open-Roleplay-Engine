ALTER TABLE generations ALTER COLUMN turn_id DROP NOT NULL;
ALTER TABLE generations ADD COLUMN suggestion_session TEXT
  CHECK ((suggestion_session IS NULL) = (turn_id IS NOT NULL)
    AND (suggestion_session IS NULL OR (kind = 'response' AND continuation_variant_id IS NULL AND context_selection IS NULL)));
CREATE INDEX suggestion_history ON generations(chat_id, suggestion_session, status);
CREATE TABLE composer_suggestion_sessions (
  chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE
);
