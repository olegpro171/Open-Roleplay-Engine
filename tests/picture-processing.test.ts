import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PictureProcessor, pictureAnalysis } from '../src/server/pictures.js';
import { cropFromControls } from '../src/shared/pictures.js';
import { pixel, pngChunk, quadrantPicture } from './support/pictures.js';
const processors: PictureProcessor[] = [];
afterEach(async () => { await Promise.all(processors.splice(0).map(processor => processor.close())); });
function processor() { const p = new PictureProcessor(); processors.push(p); return p; }

describe('isolated validated image processing', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s and renders exact source-region pixels without changing originals', async format => {
    const bytes = await quadrantPicture(format), p = processor();
    const image = await p.process(bytes, { version: 1, x: 0, y: 0, width: .25, height: .5 });
    expect(image.original).toEqual(bytes); expect(image.width).toBe(400); expect(image.height).toBe(200);
    const first = await pixel(image.thumbnail, 160, 160);
    expect(first[0]).toBeGreaterThan(230); expect(first[1]).toBeLessThan(40); expect(first[2]).toBeLessThan(40);
    expect(await sharp(image.thumbnail).metadata()).toMatchObject({ width: 320, height: 320, format: 'png', space: 'srgb' });
    expect(pictureAnalysis(image).preview).toMatch(/^data:image\/png;base64,/);
    const second = await p.process(bytes, { version: 1, x: .75, y: .5, width: .25, height: .5 });
    const color = await pixel(second.thumbnail, 100, 100);
    expect(color[0]).toBeGreaterThan(225); expect(color[1]).toBeGreaterThan(200); expect(color[2]).toBeLessThan(45);
    if (format !== 'jpeg') expect(color[3]).toBe(100);
  });
  it('uses orientation-correct source coordinates, bounds previews and supports tiny transparent pictures', async () => {
    const p = processor(), original = await quadrantPicture('jpeg', 6), image = await p.process(original);
    expect(image).toMatchObject({ width: 200, height: 400, orientation: 6, crop: { version: 1, x: 0, y: .25, width: 1, height: .5 } });
    const corner = await p.process(original, { version: 1, x: 0, y: 0, width: .5, height: .25 });
    const color = await pixel(corner.thumbnail, 160, 160); expect(color[2]).toBeGreaterThan(225); expect(color[0]).toBeLessThan(45);
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0 } } }).png().toBuffer();
    expect(await pixel((await p.process(tiny)).thumbnail)).toEqual([0, 0, 0, 0]);
    const large = await sharp({ create: { width: 2400, height: 1800, channels: 4, background: 'teal' } }).png().toBuffer();
    expect(await sharp((await p.process(large)).preview).metadata()).toMatchObject({ width: 1600, height: 1200 });
  });
  it.each([
    [2, 400, 200, [30,210,60]], [3, 400, 200, [240,210,30]],
    [4, 400, 200, [30,60,240]], [5, 200, 400, [240,30,30]],
    [7, 200, 400, [240,210,30]], [8, 200, 400, [30,210,60]],
  ] as const)('honors EXIF orientation %s before interpreting source crop coordinates', async (orientation, width, height, expected) => {
    const p = processor(), bytes = await quadrantPicture('jpeg', orientation);
    const image = await p.process(bytes, { version: 1, x: 0, y: 0, width: 100 / width, height: 100 / height });
    expect(image).toMatchObject({ width, height, orientation });
    const corner = await pixel(image.thumbnail,160,160);
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(corner[channel] - expected[channel])).toBeLessThan(5);
  });
  it('rejects signatures without decodable pixels, corrupt/truncated and unsupported files, and resource excesses', async () => {
    const p = processor(), valid = await quadrantPicture();
    for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), valid.subarray(0, 60), Buffer.concat([valid.subarray(0,8), pngChunk('tEXt', Buffer.from('chara\0e30='))])]) await expect(p.process(bytes)).rejects.toMatchObject({ status: 422 });
    await expect(p.process(Buffer.alloc(10_000_001))).rejects.toMatchObject({ code: 'picture_too_large' });
    const overPixels = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: 'white' } }).png().toBuffer();
    await expect(p.process(overPixels)).rejects.toMatchObject({ code: 'invalid_picture' });
    const overEdge = await sharp({ create: { width: 16385, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    await expect(p.process(overEdge)).rejects.toMatchObject({ code: 'invalid_picture' });
    await expect(p.process(valid, { version: 1, x: 0, y: 0, width: 1, height: 1 })).rejects.toMatchObject({ code: 'invalid_picture' });
    expect((await p.process(valid)).crop).toEqual(cropFromControls({ width: 400, height: 200 }));
  });
  it('shows only the first WebP frame and rejects frame-count excesses', async () => {
    const red = await sharp({ create: { width: 20, height: 20, channels: 4, background: 'red' } }).png().toBuffer();
    const blue = await sharp({ create: { width: 20, height: 20, channels: 4, background: 'blue' } }).png().toBuffer();
    const animated = await sharp([red, blue], { join: { animated: true } }).webp({ lossless: true, loop: 0, delay: [100, 100] }).toBuffer();
    const p = processor(), first = await p.process(animated);
    expect(first.firstFrame).toBe(true); expect(first).toMatchObject({ width: 20, height: 20 });
    expect(await pixel(first.thumbnail, 160, 160)).toEqual([255,0,0,255]);
    const frameControl = (sequence: number) => {
      const control = Buffer.alloc(26); control.writeUInt32BE(sequence); control.writeUInt32BE(20,4); control.writeUInt32BE(20,8); control.writeUInt16BE(1,20); control.writeUInt16BE(10,22); return control;
    };
    const idat = (png: Buffer) => {
      const parts: Buffer[] = [];
      for (let offset = 8; offset + 12 <= png.length;) {
        const length = png.readUInt32BE(offset);
        if (png.toString('ascii',offset+4,offset+8) === 'IDAT') parts.push(png.subarray(offset+8,offset+8+length));
        offset += length + 12;
      }
      return Buffer.concat(parts);
    };
    const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
    const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
    const apng = Buffer.concat([red.subarray(0,33),pngChunk('acTL',animation),pngChunk('fcTL',frameControl(0)),pngChunk('IDAT',idat(red)),pngChunk('fcTL',frameControl(1)),pngChunk('fDAT',Buffer.concat([sequence,idat(blue)])),pngChunk('IEND',Buffer.alloc(0))]);
    const apngFirst = await p.process(apng); expect(apngFirst.firstFrame).toBe(true); expect(await pixel(apngFirst.thumbnail,160,160)).toEqual([255,0,0,255]);
    const fallbackOutsideAnimation = Buffer.concat([red.subarray(0,33),pngChunk('acTL',animation),pngChunk('IDAT',idat(red)),pngChunk('fcTL',frameControl(0)),pngChunk('fDAT',Buffer.concat([sequence,idat(blue)])),pngChunk('IEND',Buffer.alloc(0))]);
    await expect(p.process(fallbackOutsideAnimation)).rejects.toThrow('default image');
    const count = Buffer.alloc(8); count.writeUInt32BE(257);
    const tooManyFrames = Buffer.concat([red.subarray(0,33), pngChunk('acTL', count), red.subarray(33)]);
    await expect(p.process(tooManyFrames)).rejects.toMatchObject({ code: 'invalid_picture' });
  });
  it('terminates a timed out process and can close without leaving native work running', async () => {
    const p = new PictureProcessor(1); processors.push(p);
    await expect(p.process(await quadrantPicture())).rejects.toMatchObject({ code: 'picture_timeout' });
    await p.close();
    expect((await processor().process(await quadrantPicture())).width).toBe(400);
  });
  it('cancels queued/active native work, bounds admission, closes and recovers', async () => {
    const cancelledProcessor = processor(), bytes = await quadrantPicture(), controller = new AbortController();
    const cancelled = cancelledProcessor.process(bytes, undefined, controller.signal); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'picture_cancelled' });
    await cancelledProcessor.close(); const p = processor();
    const queued = Array.from({ length: 10 }, () => p.process(bytes));
    const excess = p.process(bytes); await expect(excess).rejects.toMatchObject({ code: 'pictures_busy' });
    await Promise.all(queued);
    expect((await p.process(bytes)).width).toBe(400);
    await p.close(); await expect(p.process(bytes)).rejects.toMatchObject({ code: 'picture_cancelled' });
  }, 15000);
});
