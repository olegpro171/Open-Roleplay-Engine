import { inflateSync } from 'node:zlib';
import { AppError } from '../core/errors.js';

export function readCardFile(base64: string): unknown {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 2_000_000) throw new AppError(400, 'card_too_large', 'Card imports are limited to 2 MB.');
  let json = bytes.toString('utf8');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    json = '';
    let selected: { keyword: string; type: string; payload: Buffer } | undefined;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > bytes.length) throw new AppError(400, 'invalid_png', 'The PNG card is truncated.');
      const chunk = bytes.subarray(offset + 8, offset + 8 + size);
      const zero = chunk.indexOf(0), keyword = chunk.subarray(0, zero).toString('ascii');
      if (zero >= 0 && ['chara', 'ccv3'].includes(keyword) && ['tEXt', 'zTXt', 'iTXt'].includes(type) && (!selected || keyword === 'ccv3' && selected.keyword !== 'ccv3')) {
        selected = { keyword, type, payload: chunk.subarray(zero + 1) };
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
        json = Buffer.from(payload.toString('ascii'), 'base64').toString('utf8');
      } catch { throw new AppError(400, 'invalid_png', 'The embedded character data could not be decoded.'); }
    }
    if (!json) throw new AppError(400, 'missing_card', 'This PNG has no embedded character card. Import a character JSON or card PNG.');
  }
  try { return JSON.parse(json.replace(/^\uFEFF/, '')); }
  catch { throw new AppError(400, 'invalid_card', 'The file does not contain valid card JSON.'); }
}
