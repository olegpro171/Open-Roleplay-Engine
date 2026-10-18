import { describe, expect, it } from 'vitest';
import { cropControls, cropFromControls, cropPixels, cropSchema, pictureBase64Schema } from '../src/shared/pictures.js';

describe('oriented pixel-space crop geometry v1', () => {
  it('centers the largest square independently in tall, wide, square and tiny images', () => {
    expect(cropFromControls({ width: 400, height: 200 })).toEqual({ version: 1, x: .25, y: 0, width: .5, height: 1 });
    expect(cropFromControls({ width: 200, height: 400 })).toEqual({ version: 1, x: 0, y: .25, width: 1, height: .5 });
    expect(cropFromControls({ width: 9, height: 9 })).toEqual({ version: 1, x: 0, y: 0, width: 1, height: 1 });
    expect(cropPixels({ width: 1, height: 10 }, cropFromControls({ width: 1, height: 10 }, 4))).toEqual({ left: 0, top: 5, width: 1, height: 1 });
  });
  it('clamps travel/zoom to source edges and rounds once in oriented pixel space', () => {
    expect(cropPixels({ width: 400, height: 200 }, cropFromControls({ width: 400, height: 200 }, 4, 100, 100))).toEqual({ left: 350, top: 150, width: 50, height: 50 });
    expect(cropPixels({ width: 400, height: 200 }, cropFromControls({ width: 400, height: 200 }, 20, -10, -20))).toEqual({ left: 0, top: 0, width: 50, height: 50 });
    expect(cropControls({ width: 400, height: 200 }, { version: 1, x: .875, y: .75, width: .125, height: .25 })).toEqual({ zoom: 4, horizontal: 100, vertical: 100 });
    expect(cropPixels({ width: 16384, height: 1 }, cropFromControls({ width: 16384, height: 1 }))).toEqual({ left: 8192, top: 0, width: 1, height: 1 });
  });
  it('rejects non-square, out-of-bounds, excessive zoom and nonfinite coordinates', () => {
    const image = { width: 400, height: 200 }, base = cropFromControls(image);
    for (const invalid of [{ ...base, x: NaN }, { ...base, x: Infinity }, { ...base, x: -.1 }, { ...base, version: 2 }]) expect(cropSchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [{ ...base, width: 1 }, { ...base, x: .8 }, { ...base, width: .01, height: .02 }]) expect(() => cropPixels(image, invalid)).toThrow('bounded square');
    // Equal normalized sides on a rectangle are not equal pixel sides.
    expect(() => cropPixels(image, { ...base, width: .5, height: .5 })).toThrow('bounded square');
  });
  it('validates the full bounded base64 envelope without recursive regex stack growth', () => {
    expect(pictureBase64Schema.safeParse('a'.repeat(13_333_336)).success).toBe(true);
    for (const invalid of ['x', '!!!!', 'a=aa', 'a'.repeat(13_333_340)]) expect(pictureBase64Schema.safeParse(invalid).success).toBe(false);
  });
});
