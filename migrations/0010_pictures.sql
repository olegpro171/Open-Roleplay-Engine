CREATE TABLE picture_assets (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  width INTEGER NOT NULL CHECK(width > 0 AND width <= 16384), height INTEGER NOT NULL CHECK(height > 0 AND height <= 16384),
  orientation INTEGER NOT NULL, first_frame INTEGER NOT NULL CHECK(first_frame IN (0,1)),
  original BLOB NOT NULL CHECK(length(original) <= 10000000), preview BLOB NOT NULL CHECK(length(preview) <= 12000000), rendition_version INTEGER NOT NULL,
  CHECK(width * height <= 40000000)
);
CREATE TABLE character_pictures (
  character_id TEXT PRIMARY KEY REFERENCES library(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES picture_assets(id), key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
  crop TEXT NOT NULL, thumbnail BLOB NOT NULL CHECK(length(thumbnail) <= 600000)
);
CREATE INDEX character_pictures_asset ON character_pictures(asset_id);
CREATE TRIGGER character_pictures_kind BEFORE INSERT ON character_pictures
WHEN NOT EXISTS(SELECT 1 FROM library WHERE id = NEW.character_id AND kind = 'characters')
BEGIN SELECT RAISE(ABORT, 'Pictures belong to characters'); END;
