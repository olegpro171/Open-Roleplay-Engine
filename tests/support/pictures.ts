import sharp from 'sharp';
import { crc32 } from 'node:zlib';
export async function quadrantPicture(format: 'png' | 'jpeg' | 'webp' = 'png', orientation?: number) {
  const width = 400, height = 200, pixels = Buffer.alloc(width * height * 4);
  const colors = [[240,30,30,255], [30,210,60,255], [30,60,240,255], [240,210,30,100]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[Number(x >= 200) + 2 * Number(y >= 100)];
    for (let c = 0; c < 4; c++) pixels[(y * width + x) * 4 + c] = format === 'jpeg' && c === 3 ? 255 : color[c];
  }
  let image = sharp(pixels, { raw: { width, height, channels: 4 } });
  if (orientation) image = image.withMetadata({ orientation });
  return image.toFormat(format).toBuffer();
}
export function pngChunk(type: string, payload: Buffer) {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length); chunk.write(type, 4); payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
export function cardPng(image: Buffer, value: unknown, keyword = 'chara') {
  return Buffer.concat([image.subarray(0, -12), pngChunk('tEXt', Buffer.from(`${keyword}\0${Buffer.from(JSON.stringify(value)).toString('base64')}`)), image.subarray(-12)]);
}
export async function pixel(bytes: Buffer, x = 0, y = 0) {
  const image = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...image.data.subarray((y * image.info.width + x) * 4, (y * image.info.width + x) * 4 + 4)];
}
