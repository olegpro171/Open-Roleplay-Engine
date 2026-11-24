import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { themeSchema, type Theme } from '../src/shared/appearance';
import { installIconLinks } from '../src/shared/favicon';

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

const installTileColors: Record<Theme, readonly number[]> = {
  dark: [41, 39, 37],
  light: [237, 233, 227],
  'midnight-black': [32, 32, 32],
  porcelain: [252, 250, 248],
};

it.each(themeSchema.options)('gives %s install icons room around the bird and the correct corners', async theme => {
  const { appleTouch, manifest } = installIconLinks(theme);
  const { icons }: { icons: { src: string; sizes: string; purpose: string }[] } = JSON.parse(
    await readFile(new URL(`../public${manifest}`, import.meta.url), 'utf8'),
  );
  const desktopIcons = icons.filter(icon => icon.purpose === 'any');
  expect.soft(desktopIcons.map(icon => icon.sizes)).toEqual(['192x192', '512x512']);
  const assets = [
    { src: appleTouch, rounded: false },
    ...desktopIcons.filter(icon => icon.sizes !== 'any').map(icon => ({ src: icon.src, rounded: true })),
  ];
  const tile = installTileColors[theme];
  for (const { src, rounded } of assets) {
    const png = await readFile(new URL(`../public${src}`, import.meta.url));
    const { data, info: { width, height, channels } } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const center = Math.floor(width / 2);
    const nearCorner = Math.floor(width * 0.05);
    const pixelAt = (x: number, y: number) => {
      const offset = (y * width + x) * channels;
      return [...data.subarray(offset, offset + channels)];
    };
    expect.soft(pixelAt(center, 0), src).toEqual([...tile, 255]);
    if (rounded) {
      expect.soft(pixelAt(nearCorner, nearCorner)[3], src).toBe(0);
      expect.soft(pixelAt(width - 1, height - 1)[3], src).toBe(0);
    } else {
      expect.soft(pixelAt(0, 0), src).toEqual([...tile, 255]);
      expect.soft(pixelAt(width - 1, height - 1), src).toEqual([...tile, 255]);
    }

    let firstBirdRow = height;
    let lastBirdRow = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * channels;
        if (data[offset + 3] === 255 && tile.some((color, channel) => Math.abs(color - data[offset + channel]) > 20)) {
          firstBirdRow = Math.min(firstBirdRow, y);
          lastBirdRow = y;
          break;
        }
      }
    }
    const birdHeight = (lastBirdRow - firstBirdRow + 1) / height;
    expect.soft(birdHeight, src).toBeGreaterThanOrEqual(0.75);
    expect.soft(birdHeight, src).toBeLessThanOrEqual(0.80);
    expect.soft(firstBirdRow / height, src).toBeGreaterThanOrEqual(0.10);
    expect.soft((height - 1 - lastBirdRow) / height, src).toBeGreaterThanOrEqual(0.10);
  }
});
