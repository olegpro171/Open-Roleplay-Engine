import { characterCardLimits } from '../shared/character-card-limits.js';
import { pictureLimits } from '../shared/pictures.js';

export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function pictureByteLimit(bytes: Buffer) {
  return bytes.subarray(0, pngSignature.length).equals(pngSignature)
    ? characterCardLimits.pngBytes : pictureLimits.bytes;
}
