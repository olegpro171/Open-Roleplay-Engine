import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it } from 'vitest';

const faviconSizes = [16, 32, 48];

it.each(faviconSizes)('uses the full charcoal tile in the %ipx tab favicon', async size => {
  const png = await readFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url));
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(size);
  expect(info.height).toBe(size);
  const pixelAt = (x: number, y: number) => {
    const offset = (y * size + x) * info.channels;
    return [...data.subarray(offset, offset + info.channels)];
  };
  const edge = size - 1;
  const charcoal = [41, 39, 37, 255];
  for (const [x, y] of [[0, 0], [edge, 0], [0, edge], [edge, edge]]) {
    expect(pixelAt(x, y)).toEqual(charcoal);
  }

  const ico = await readFile(new URL('../public/favicon.ico', import.meta.url));
  const entry = 6 + faviconSizes.indexOf(size) * 16;
  expect(ico[entry]).toBe(size);
  expect(ico[entry + 1]).toBe(size);
  const length = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  expect(ico.subarray(offset, offset + length)).toEqual(png);
});
