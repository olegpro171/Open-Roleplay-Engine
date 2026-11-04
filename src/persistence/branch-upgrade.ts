import type Database from 'better-sqlite3';

// The initial branch keeps the old chat ID and every dependent record.
export function upgradeSingleBranches(db: Database.Database) {
  db.exec(`
    INSERT INTO chat_groups (id, settings)
    SELECT id, json_remove(settings, '$.authorNote') FROM chats WHERE group_id IS NULL;
    UPDATE chats SET group_id = id, settings = CASE
      WHEN json_type(settings, '$.authorNote') IS NULL THEN '{}'
      ELSE json_object('authorNote', json_extract(settings, '$.authorNote'))
      END WHERE group_id IS NULL;
  `);
}
