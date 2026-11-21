CREATE TABLE composer_drafts (
  chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  sent_revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  edit TEXT
);
