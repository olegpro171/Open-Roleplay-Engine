import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const artwork = await readFile(resolve(root, 'public/icons/ore-mark-dark.svg'));
const tileBackground = '#292725'; // Matches the default SVG tile fill.
for (const size of [180, 192, 512, 1024]) {
  const png = await sharp(artwork, { density: 96 }).resize(size, size).png().toBuffer();
  const destination = size === 180
    ? 'public/apple-touch-icon.png'
    : `public/icons/icon-${size}.png`;
  await writeFile(resolve(root, destination), png);
}

// Full-bleed artwork lets macOS apply its own icon mask without a white backing.
for (const size of [192, 512, 1024]) {
  // Keep the crest's tips inside the platform's circular maskable safe zone.
  const inset = Math.ceil(size * 0.03);
  const artworkSize = size - 2 * inset;
  await sharp(artwork, { density: 96 }).resize(artworkSize, artworkSize)
    .flatten({ background: tileBackground })
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: tileBackground })
    .png()
    .toFile(resolve(root, `public/icons/maskable-${size}.png`));
}

const faviconArtwork = await readFile(resolve(root, 'public/icons/favicon-peach-bold.svg'));
const faviconSizes = [16, 32, 48];
const faviconPngs = await Promise.all(faviconSizes.map(async size => {
  const file = resolve(root, `public/icons/icon-${size}.png`);
  // Preserve the supplied 32px PNG as an input to the ICO.
  if (size === 32) return readFile(file);
  const png = await sharp(faviconArtwork, { density: 96 }).resize(size, size).png().toBuffer();
  await writeFile(file, png);
  return png;
}));

// ICO stores one PNG payload per size; this covers older favicon consumers too.
const header = Buffer.alloc(6 + faviconSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(faviconSizes.length, 4);
let offset = header.length;
for (const [index, png] of faviconPngs.entries()) {
  const size = faviconSizes[index];
  const entry = 6 + index * 16;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(resolve(root, 'public/favicon.ico'), Buffer.concat([header, ...faviconPngs]));

const manifestPath = resolve(root, 'public/site.webmanifest');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const variant of ['peach', 'light', 'midnight-black', 'porcelain']) {
  const name = `${variant}-bold`;
  const svg = `/icons/favicon-${name}.svg`;
  const source = await readFile(resolve(root, `public${svg}`));
  const base = `/icons/app-${name}`;
  const icons = [{ src: svg, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }];
  for (const size of [192, 512]) {
    const src = `${base}-${size}.png`;
    await sharp(source).resize(size, size).png().toFile(resolve(root, `public${src}`));
    icons.push({ src, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' });
  }

  // The favicon's crest reaches the canvas edge. Keep it within the
  // maskable safe zone while extending its own solid tile to the edge.
  const [r, g, b] = await sharp(source)
    .extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  const size = 1024;
  const inset = Math.ceil(size * 0.11);
  const contentSize = size - 2 * inset;
  const maskableSrc = `${base}-maskable-1024.png`;
  await sharp(source).resize(contentSize, contentSize)
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { r, g, b } })
    .removeAlpha().png().toFile(resolve(root, `public${maskableSrc}`));
  icons.push({ src: maskableSrc, sizes: '1024x1024', type: 'image/png', purpose: 'maskable' });

  const destination = variant === 'peach' ? manifestPath : resolve(root, `public/site-${variant}.webmanifest`);
  const output = { ...manifest, id: '/', icons };
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n');
}
