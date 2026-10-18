ALTER TABLE turns ADD COLUMN selected_variant_id TEXT;
ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'response' CHECK (kind IN ('response', 'regeneration'));
ALTER TABLE generations ADD COLUMN context_selection TEXT;
CREATE TABLE response_variants (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX response_variants_turn ON response_variants(turn_id);
INSERT INTO response_variants (id, turn_id, text, source_revision, generation_id, created_at)
SELECT 'original-' || t.id, t.id, t.assistant_text, t.assistant_revision,
  (SELECT g.id FROM generations g WHERE g.turn_id = t.id AND g.status = 'succeeded' ORDER BY g.rowid DESC LIMIT 1),
  COALESCE((SELECT g.created_at FROM generations g WHERE g.turn_id = t.id AND g.status = 'succeeded' ORDER BY g.rowid DESC LIMIT 1), '')
FROM turns t WHERE t.complete = 1;
UPDATE turns SET selected_variant_id = 'original-' || id WHERE complete = 1;
