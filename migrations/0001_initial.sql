CREATE TABLE chats (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT NOT NULL);
CREATE TABLE connections (id TEXT PRIMARY KEY, settings TEXT NOT NULL);
CREATE TABLE credentials (id TEXT PRIMARY KEY REFERENCES connections(id), api_key TEXT NOT NULL);
CREATE TABLE owners (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE runtime_owner (id INTEGER PRIMARY KEY CHECK (id = 1), process_id INTEGER NOT NULL, token TEXT NOT NULL);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  user_id TEXT NOT NULL UNIQUE, user_revision INTEGER NOT NULL, user_text TEXT NOT NULL,
  assistant_id TEXT NOT NULL UNIQUE, assistant_revision INTEGER NOT NULL, assistant_text TEXT NOT NULL
);
CREATE UNIQUE INDEX one_pending_turn ON turns (complete) WHERE complete = 0;
CREATE TABLE generations (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, command TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  source_revision INTEGER NOT NULL, request TEXT, partial_text TEXT NOT NULL, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_generation ON generations (status) WHERE status = 'running';
