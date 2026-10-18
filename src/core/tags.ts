import { z } from 'zod';
import { AppError } from './errors.js';
import { canonicalTagName, normalizeTagName, tagLimits, type TagCandidates } from '../shared/tags.js';

/** Modern nested data is authoritative; compatibility root fields are never combined. */
export function readEmbeddedTags(source: unknown): TagCandidates {
  const raw = z.record(z.string(), z.unknown()).parse(source);
  const data = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' ? z.record(z.string(), z.unknown()).parse(raw.data) : raw;
  const candidates = new Map<string, TagCandidates['candidates'][number]>();
  const notices: string[] = [];
  let noticeCount = 0;
  function notice(message: string) { noticeCount++; if (notices.length < tagLimits.diagnostics) notices.push(message); }
  const tags = data.tags;
  if (tags !== undefined && !Array.isArray(tags)) notice('Embedded tags are not an array. This representation is preserved but cannot be assigned locally.');
  if (Array.isArray(tags)) {
    if (tags.length > tagLimits.metadataEntries) throw new AppError(400, 'tag_metadata_limit', `Embedded tag metadata exceeds ${tagLimits.metadataEntries} entries. Reduce the source metadata before importing.`);
    let characters = 0;
    for (let index = 0; index < tags.length; index++) {
      const value: unknown = tags[index];
      if (typeof value !== 'string') { notice(`Tag ${index + 1} is not text and will remain preserved metadata only.`); continue; }
      characters += value.length;
      if (characters > tagLimits.metadataCharacters) throw new AppError(400, 'tag_metadata_limit', `Embedded tag text exceeds ${tagLimits.metadataCharacters} characters. Reduce the source metadata before importing.`);
      const name = normalizeTagName(value);
      if (!name) { notice(`Tag ${index + 1} is blank and cannot be assigned locally.`); continue; }
      const key = canonicalTagName(name), existing = candidates.get(key);
      if (existing) existing.sourceIndexes.push(index);
      else {
        if (candidates.size >= tagLimits.candidates) throw new AppError(400, 'tag_metadata_limit', `Embedded tags exceed ${tagLimits.candidates} unique candidates. Reduce the source metadata before importing.`);
        candidates.set(key, { name, key, sourceIndexes: [index], eligible: name.length <= tagLimits.name });
        if (name.length > tagLimits.name) notice(`Tag ${index + 1} exceeds the local ${tagLimits.name}-character name limit. Import all is unavailable; the original text is preserved.`);
      }
    }
  }
  return { candidates: [...candidates.values()], notices, omittedNotices: noticeCount - notices.length };
}
