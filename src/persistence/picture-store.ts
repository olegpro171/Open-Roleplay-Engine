import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { cropSchema, type CharacterPicture, type PictureMutation } from '../shared/pictures.js';
import type { PreparedPicture } from './picture-data.js';

const relationSchema = z.object({ character_id: z.string(), key: z.string(), revision: z.number(), crop: z.string().transform(value => cropSchema.parse(JSON.parse(value))), width: z.number(), height: z.number() });
const descriptorColumns = 'p.character_id, p.key, p.revision, p.crop, a.width, a.height';
export class PictureStore {
  constructor(private readonly sqlite: Database.Database, private readonly bump: () => void) {}
  private descriptor(value: unknown): CharacterPicture {
    const row = relationSchema.parse(value), base = `/api/library/characters/${encodeURIComponent(row.character_id)}/picture/${row.key}`;
    return { characterId: row.character_id, key: row.key, revision: row.revision, crop: row.crop, width: row.width, height: row.height, thumbnailUrl: `${base}/thumbnail`, previewUrl: `${base}/preview`, originalUrl: `${base}/original` };
  }
  list(): CharacterPicture[] {
    return this.sqlite.prepare(`SELECT ${descriptorColumns} FROM character_pictures p JOIN picture_assets a ON a.id = p.asset_id`).all().map(row => this.descriptor(row));
  }
  get(characterId: string): CharacterPicture | null {
    const row = this.sqlite.prepare(`SELECT ${descriptorColumns} FROM character_pictures p JOIN picture_assets a ON a.id = p.asset_id WHERE p.character_id = ?`).get(characterId);
    return row ? this.descriptor(row) : null;
  }
  check(characterId: string | undefined, expected: string | null) {
    if ((characterId ? this.get(characterId)?.key ?? null : null) !== expected) throw new AppError(409, 'picture_conflict', 'The saved picture changed. Review the current character before reapplying your picture draft.');
  }
  resource(characterId: string, key: string, kind: 'original' | 'preview' | 'thumbnail') {
    const row = this.sqlite.prepare(`SELECT ${kind === 'thumbnail' ? 'p.thumbnail' : `a.${kind}`} AS bytes, a.mime FROM character_pictures p JOIN picture_assets a ON a.id = p.asset_id WHERE p.character_id = ? AND p.key = ?`).get(characterId, key);
    if (!row) throw new AppError(404, 'picture_not_found', 'This picture is no longer available. Refresh the library.');
    const parsed = z.object({ bytes: z.instanceof(Buffer), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).parse(row);
    return { bytes: parsed.bytes, mime: kind === 'original' ? parsed.mime : 'image/png' };
  }
  originalForCrop(characterId: string, key: string) { return this.resource(characterId, key, 'original').bytes; }
  apply(characterId: string, mutation: Exclude<PictureMutation, { mode: 'replace' }> | { mode: 'replace'; crop: import('../shared/pictures.js').PictureCrop } | undefined, prepared?: PreparedPicture) {
    if (!this.sqlite.inTransaction) throw new Error('Picture writes require a checked transaction.');
    if (!mutation) return false;
    const previous = this.get(characterId);
    if (mutation.mode === 'remove') {
      if (!previous) return false;
      this.sqlite.prepare('DELETE FROM character_pictures WHERE character_id = ?').run(characterId);
    } else {
      if (mutation.mode === 'keep' && previous?.key !== mutation.key) throw new AppError(409, 'picture_conflict', 'The saved picture changed. Review it before applying this crop.');
      if (!prepared) throw new Error('Picture renditions must be prepared before commit.');
      const oldAsset = this.sqlite.prepare('SELECT a.id, a.digest FROM picture_assets a JOIN character_pictures p ON p.asset_id = a.id WHERE p.character_id = ?').get(characterId);
      const old = oldAsset ? z.object({ id: z.string(), digest: z.string() }).parse(oldAsset) : null;
      if (previous && old?.digest === prepared.digest && isDeepStrictEqual(previous.crop, prepared.crop)) return false;
      let assetId = old?.digest === prepared.digest ? old.id : undefined;
      if (!assetId) {
        assetId = randomUUID();
        this.sqlite.prepare('INSERT INTO picture_assets (id,digest,mime,width,height,orientation,first_frame,original,preview,rendition_version) VALUES (?,?,?,?,?,?,?,?,?,?)').run(assetId, prepared.digest, prepared.mime, prepared.width, prepared.height, prepared.orientation, Number(prepared.firstFrame), prepared.original, prepared.preview, prepared.renditionVersion);
      }
      this.sqlite.prepare('INSERT INTO character_pictures (character_id,asset_id,key,revision,crop,thumbnail) VALUES (?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET asset_id=excluded.asset_id,key=excluded.key,revision=excluded.revision,crop=excluded.crop,thumbnail=excluded.thumbnail').run(characterId, assetId, randomUUID(), (previous?.revision ?? -1) + 1, JSON.stringify(prepared.crop), prepared.thumbnail);
    }
    this.cleanup(); this.bump();
    return true;
  }
  duplicate(source: string, target: string) {
    if (!this.sqlite.inTransaction) throw new Error('Picture duplication requires a checked transaction.');
    this.sqlite.prepare('INSERT INTO character_pictures (character_id,asset_id,key,revision,crop,thumbnail) SELECT ?,asset_id,?,0,crop,thumbnail FROM character_pictures WHERE character_id = ?').run(target, randomUUID(), source);
  }
  cleanup() {
    if (!this.sqlite.inTransaction) throw new Error('Asset cleanup requires a transaction.');
    this.sqlite.prepare('DELETE FROM picture_assets WHERE NOT EXISTS(SELECT 1 FROM character_pictures p WHERE p.asset_id = picture_assets.id)').run();
  }
}
