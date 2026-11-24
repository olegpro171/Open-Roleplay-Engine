import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { themeSchema, type Theme } from '../src/shared/appearance';
import { faviconLinks, installIconLinks } from '../src/shared/favicon';

const faviconSizes = [16, 32, 48];

async function expectTransparentCrest(artwork: Buffer, size: number) {
  const data = await sharp(artwork).resize(size, size).ensureAlpha().raw().toBuffer();
  const edge = size - 1;
  for (const [x, y] of [[0, 0], [edge, 0], [0, edge], [edge, edge]]) {
    expect(data[(y * size + x) * 4 + 3]).toBe(0);
  }
  expect(data.some((value, index) => index % 4 === 3 && value >= 192)).toBe(true);
}

it.each(faviconSizes)('uses a transparent background in the %ipx legacy favicon', async size => {
  const png = await readFile(new URL(`../public/icons/icon-${size}.png`, import.meta.url));
  expect(await sharp(png).metadata()).toMatchObject({ width: size, height: size });
  await expectTransparentCrest(png, size);

  const ico = await readFile(new URL('../public/favicon.ico', import.meta.url));
  const entry = 6 + faviconSizes.indexOf(size) * 16;
  expect(ico[entry]).toBe(size);
  expect(ico[entry + 1]).toBe(size);
  const length = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  expect(ico.subarray(offset, offset + length)).toEqual(png);
});

it.each(themeSchema.options)('gives %s SVG and PNG tab favicons a transparent background', async theme => {
  const { svg, png } = faviconLinks(theme);
  const raster = await readFile(new URL(`../public${png}`, import.meta.url));
  expect(await sharp(raster).metadata()).toMatchObject({ width: 32, height: 32 });
  await expectTransparentCrest(raster, 32);
  await expectTransparentCrest(await readFile(new URL(`../public${svg}`, import.meta.url)), 32);
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
