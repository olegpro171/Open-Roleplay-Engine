import { message } from '../shared/localization.js';
import { inflateSync } from 'node:zlib';
import { AppError } from '../core/errors.js';

export function readCardFile(base64: string): unknown {
  return readCharacterCardFile(base64, 2_000_000).value;
}
export function readCharacterCardFile(base64: string, fileLimit = 10_000_000): { value: unknown; artwork?: Buffer } {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > fileLimit) throw new AppError(400, 'card_too_large', message("errors.card_files_are_limited_to_mb", { value: String(fileLimit / 1_000_000) }));
  let artwork: Buffer | undefined;
  let json = '';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    artwork = bytes;
    let selected: { keyword: string; type: string; payload: Buffer } | undefined;
    let chunks = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (++chunks > 20_000) throw new AppError(400, 'card_chunk_limit', message("errors.this_png_has_too_many_chunks_export_a"));
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > bytes.length) throw new AppError(400, 'invalid_png', message("errors.the_png_card_is_truncated"));
      if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
        const chunk = bytes.subarray(offset + 8, offset + 8 + size);
        // PNG keywords are at most 79 bytes. Never scan/convert compressed artwork
        // or a whole malformed text payload merely to discover its keyword.
        const zero = chunk.subarray(0, 80).indexOf(0);
        const keyword = zero < 0 ? '' : chunk.toString('ascii', 0, zero);
        if (['chara', 'ccv3'].includes(keyword)) {
          if (chunk.length > 2_000_000) throw new AppError(400, 'card_metadata_too_large', message("errors.embedded_metadata_text_is_limited_to_2_mb"));
          if (!selected || keyword === 'ccv3' && selected.keyword !== 'ccv3') selected = { keyword, type, payload: chunk.subarray(zero + 1) };
        }
      }
      offset += size + 12;
    }
    if (selected) {
      const { type } = selected;
      let { payload } = selected;
      try {
        if (type === 'zTXt') { if (payload[0] !== 0) throw new Error(); payload = inflateSync(payload.subarray(1), { maxOutputLength: 2_000_000 }); }
        if (type === 'iTXt') {
          const compressed = payload[0], method = payload[1];
          payload = payload.subarray(2);
          const language = payload.indexOf(0); if (language < 0) throw new Error(); payload = payload.subarray(language + 1);
          const translated = payload.indexOf(0); if (translated < 0) throw new Error(); payload = payload.subarray(translated + 1);
          if (compressed === 1 && method === 0) payload = inflateSync(payload, { maxOutputLength: 2_000_000 });
          else if (compressed !== 0) throw new Error();
        }
        if (payload.length > 2_000_000) throw new Error();
        const decoded = Buffer.from(payload.toString('ascii'), 'base64');
        if (decoded.length > 2_000_000) throw new Error();
        json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      } catch { throw new AppError(400, 'invalid_png', message("errors.the_embedded_character_data_could_not_be_decoded")); }
    }
    if (!json) throw new AppError(400, 'missing_card', message("errors.this_png_has_no_embedded_character_card_import"));
  }
  if (!artwork && bytes.length > 2_000_000) throw new AppError(400, 'card_too_large', message("errors.json_cards_are_limited_to_2_mb"));
  try {
    if (!artwork) json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(json.replace(/^\uFEFF/, '')), artwork };
  }
  catch { throw new AppError(400, 'invalid_card', message("errors.the_file_does_not_contain_valid_card_json")); }
}
