CREATE TABLE context_states (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE summaries (
  id TEXT NOT NULL, revision INTEGER NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, data TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE INDEX summaries_chat ON summaries(chat_id);
CREATE TABLE context_jobs (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE, command TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX context_jobs_chat ON context_jobs(chat_id);
CREATE UNIQUE INDEX one_active_context_job ON context_jobs(chat_id) WHERE json_extract(data, '$.status') = 'running';
CREATE TABLE context_steps (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES context_jobs(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE INDEX context_steps_job ON context_steps(job_id);
