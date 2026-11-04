CREATE TABLE chat_groups (
  id TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);
ALTER TABLE chats ADD COLUMN group_id TEXT REFERENCES chat_groups(id) ON DELETE CASCADE;
ALTER TABLE chats ADD COLUMN branch_name TEXT;
CREATE INDEX chats_group ON chats(group_id);
ALTER TABLE summaries ADD COLUMN fork_source_request TEXT;
CREATE INDEX context_step_source_request ON context_steps(json_extract(data, '$.result.id'), json_extract(data, '$.result.revision'))
  WHERE json_type(data, '$.request') = 'object';
CREATE TABLE branch_commands (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  result TEXT NOT NULL
);
