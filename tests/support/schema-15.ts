import { removePinSchema } from './schema-16.js';
import type Database from 'better-sqlite3';

/** Reconstruct the pre-branch layout for populated migration fixtures. */
export function removeBranchSchema(db: Database.Database) {
  removePinSchema(db);
  db.exec(`
    UPDATE chats SET settings = json_patch((SELECT settings FROM chat_groups WHERE id = chats.group_id), settings);
    DROP INDEX chats_group;
    DROP INDEX context_step_source_request;
    ALTER TABLE chats DROP COLUMN branch_name;
    ALTER TABLE chats DROP COLUMN group_id;
    ALTER TABLE summaries DROP COLUMN fork_source_request;
    DROP TABLE chat_groups;
    DROP TABLE branch_commands;
  `);
}
