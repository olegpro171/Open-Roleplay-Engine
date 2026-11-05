ALTER TABLE turns ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1) AND (pinned = 0 OR complete = 1));
CREATE INDEX turns_pinned ON turns (chat_id, position) WHERE pinned = 1;
