ALTER TABLE connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE library (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE library_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO library_state VALUES (1, 0);
DROP INDEX one_active_generation;
DROP INDEX one_pending_turn;
ALTER TABLE generations RENAME TO generations_old;
ALTER TABLE turns RENAME TO turns_old;
CREATE TABLE turns (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  user_id TEXT NOT NULL UNIQUE, user_revision INTEGER NOT NULL, user_text TEXT NOT NULL,
  assistant_id TEXT NOT NULL UNIQUE, assistant_revision INTEGER NOT NULL, assistant_text TEXT NOT NULL,
  UNIQUE(chat_id, position)
);
INSERT INTO turns SELECT id, 'main', position, complete, user_id, user_revision, user_text, assistant_id, assistant_revision, assistant_text FROM turns_old;
CREATE UNIQUE INDEX one_pending_turn ON turns (chat_id) WHERE complete = 0;
CREATE TABLE generations (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE, command TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  source_revision INTEGER NOT NULL, request TEXT, partial_text TEXT NOT NULL, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO generations SELECT id, 'main', request_id, command, turn_id, status, source_revision, request, partial_text, error, created_at, updated_at FROM generations_old;
DROP TABLE generations_old;
DROP TABLE turns_old;
CREATE UNIQUE INDEX one_active_generation ON generations (chat_id) WHERE status = 'running';
CREATE INDEX generation_chat ON generations (chat_id);
