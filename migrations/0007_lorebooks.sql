CREATE TABLE IF NOT EXISTS lore_epochs (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lore_states (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(chat_id, book_id)
);
CREATE TABLE IF NOT EXISTS lore_commands (
  request_id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lore_operations (
  operation_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  resolution TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lore_operations_chat ON lore_operations(chat_id);
