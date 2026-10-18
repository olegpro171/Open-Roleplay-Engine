CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  -- The shared validator enforces 100 UTF-16 units. A byte guard also handles
  -- embedded NUL text, for which SQLite length(TEXT) stops prematurely.
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 400),
  canonical_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE UNIQUE INDEX tags_canonical_key ON tags(canonical_key);
CREATE TABLE character_tags (
  character_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (character_id, tag_id)
);
CREATE INDEX character_tags_by_tag ON character_tags(tag_id, character_id);
CREATE TRIGGER character_tags_require_character BEFORE INSERT ON character_tags
WHEN NOT EXISTS (SELECT 1 FROM library WHERE id = NEW.character_id AND kind = 'characters')
BEGIN SELECT RAISE(ABORT, 'Tag assignments require a character'); END;
CREATE TRIGGER character_tags_update_require_character BEFORE UPDATE OF character_id ON character_tags
WHEN NOT EXISTS (SELECT 1 FROM library WHERE id = NEW.character_id AND kind = 'characters')
BEGIN SELECT RAISE(ABORT, 'Tag assignments require a character'); END;
CREATE TRIGGER tagged_character_kind BEFORE UPDATE OF kind ON library
WHEN NEW.kind != 'characters' AND EXISTS (SELECT 1 FROM character_tags WHERE character_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'An assigned character cannot change kind'); END;
