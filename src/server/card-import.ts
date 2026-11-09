import { message } from '../shared/localization.js';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AppError } from '../core/errors.js';
import { PassThrough, type Readable } from 'node:stream';
import { characterCardLimits } from '../shared/character-card-limits.js';
import { pictureLimits } from '../shared/pictures.js';
import { assertCharacterSourceDepth } from '../core/cards.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const { pngBytes, jsonBytes, embeddedBytes } = characterCardLimits;
const legacyJsonBytes = 2_000_000;
const cardSizeError = (limit: number) => new AppError(413, 'card_too_large', message('errors.card_files_are_limited_to_mb', { value: String(limit / 1_000_000) }));
export function readCardFile(base64: string): unknown {
  return readBase64Card(base64, legacyJsonBytes).value;
}
export function readCharacterCardFile(base64: string) {
  return readBase64Card(base64, pictureLimits.bytes);
}
function readBase64Card(base64: string, fileLimit: number) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > fileLimit) {
    throw new AppError(400, 'card_too_large', message('errors.card_files_are_limited_to_mb', { value: String(fileLimit / 1_000_000) }));
  }
  if (bytes.length > legacyJsonBytes && !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new AppError(400, 'card_too_large', message('errors.json_cards_are_limited_to_2_mb'));
  }
  return readCardBytes(bytes);
}
export async function readCharacterCardUpload(stream: Readable, declaredLength: string | undefined, shutdown: AbortSignal) {
  const length = declaredLength === undefined ? undefined : Number(declaredLength);
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > pngBytes)) throw cardSizeError(pngBytes);
  // Keep the HTTP stream alive long enough for an upload rejection to reach the client.
  const input = new PassThrough();
  const interrupted = () => new AppError(400, 'card_upload_interrupted', message('errors.character_card_upload_interrupted'));
  const onError = () => { input.destroy(interrupted()); };
  const onClose = () => { if (!stream.readableEnded) onError(); };
  const onShutdown = () => { input.destroy(new AppError(503, 'server_stopping', message('errors.the_server_is_stopping'))); };
  const timer = setTimeout(() => input.destroy(interrupted()), 5 * 60_000);
  timer.unref();
  stream.once('error', onError);
  stream.once('close', onClose);
  shutdown.addEventListener('abort', onShutdown, { once: true });
  stream.pipe(input);
  if (shutdown.aborted) onShutdown();
  else if (stream.destroyed && !stream.readableEnded) onError();
  try {
    const header = Buffer.alloc(pngSignature.length);
    let received = 0;
    let limit: number = pngBytes;
    let bytes: Buffer | undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of input.iterator({ destroyOnReturn: false })) {
      if (received < header.length) {
        chunk.copy(header, received, 0, header.length - received);
        if (received + chunk.length >= header.length) limit = header.equals(pngSignature) ? pngBytes : jsonBytes;
      }
      const next = received + chunk.length;
      if (next > limit || (length !== undefined && length > limit)) throw cardSizeError(limit);
      if (length !== undefined && next > length) throw interrupted();
      if (!bytes && length !== undefined && next >= header.length) {
        bytes = Buffer.allocUnsafe(length);
        header.copy(bytes, 0, 0, received);
        chunks.length = 0;
      }
      if (bytes) chunk.copy(bytes, received);
      else chunks.push(chunk);
      received = next;
    }
    if (length !== undefined && received !== length) throw interrupted();
    const file = bytes ?? Buffer.concat(chunks, received);
    const parsed = readCardBytes(file);
    assertCharacterSourceDepth(parsed.value);
    return { ...parsed, digest: createHash('sha256').update(file).digest('hex') };
  } finally {
    clearTimeout(timer);
    stream.unpipe(input);
    stream.off('error', onError);
    stream.off('close', onClose);
    shutdown.removeEventListener('abort', onShutdown);
    input.destroy();
  }
}

function readCardBytes(bytes: Buffer): { value: unknown; artwork?: Buffer } {
  let artwork: Buffer | undefined;
  let json = '';
  if (bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
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
          if (chunk.length > embeddedBytes) throw new AppError(400, 'card_metadata_too_large', message("errors.embedded_metadata_text_is_limited_to_2_mb"));
          if (!selected || keyword === 'ccv3' && selected.keyword !== 'ccv3') selected = { keyword, type, payload: chunk.subarray(zero + 1) };
        }
      }
      offset += size + 12;
    }
    if (selected) {
      const { type } = selected;
      let { payload } = selected;
      try {
        if (type === 'zTXt') { if (payload[0] !== 0) throw new Error(); payload = inflateSync(payload.subarray(1), { maxOutputLength: embeddedBytes }); }
        if (type === 'iTXt') {
          const compressed = payload[0], method = payload[1];
          payload = payload.subarray(2);
          const language = payload.indexOf(0); if (language < 0) throw new Error(); payload = payload.subarray(language + 1);
          const translated = payload.indexOf(0); if (translated < 0) throw new Error(); payload = payload.subarray(translated + 1);
          if (compressed === 1 && method === 0) payload = inflateSync(payload, { maxOutputLength: embeddedBytes });
          else if (compressed !== 0) throw new Error();
        }
        if (payload.length > embeddedBytes) throw new Error();
        const decoded = Buffer.from(payload.toString('ascii'), 'base64');
        if (decoded.length > embeddedBytes) throw new Error();
        json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      } catch { throw new AppError(400, 'invalid_png', message("errors.the_embedded_character_data_could_not_be_decoded")); }
    }
    if (!json) throw new AppError(400, 'missing_card', message("errors.this_png_has_no_embedded_character_card_import"));
  }
  try {
    if (!artwork) json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(json.replace(/^\uFEFF/, '')), artwork };
  }
  catch { throw new AppError(400, 'invalid_card', message("errors.the_file_does_not_contain_valid_card_json")); }
}
