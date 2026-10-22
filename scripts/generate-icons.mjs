import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const artwork = await readFile(resolve(root, 'artwork/ore-mark.svg'));
const sizes = [16, 32, 48, 180, 192, 512, 1024];
const icons = new Map();

for (const size of sizes) {
  const image = sharp(artwork, { density: 96 }).resize(size, size);
  if (size <= 48) image.flatten({ background: "#292725" });
  const png = await image.png().toBuffer();
  icons.set(size, png);
  const destination = size === 180
    ? 'public/apple-touch-icon.png'
    : `public/icons/icon-${size}.png`;
  await mkdir(dirname(resolve(root, destination)), { recursive: true });
  await writeFile(resolve(root, destination), png);
}

// Full-bleed artwork lets macOS apply its own icon mask without a white backing.
for (const size of [192, 512, 1024]) {
  await sharp(artwork, { density: 96 }).resize(size, size)
    .flatten({ background: "#292725" }).png()
    .toFile(resolve(root, `public/icons/maskable-${size}.png`));
}

// ICO stores one PNG payload per size; this covers older favicon consumers too.
const faviconSizes = [16, 32, 48];
const header = Buffer.alloc(6 + faviconSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(faviconSizes.length, 4);
let offset = header.length;
for (const [index, size] of faviconSizes.entries()) {
  const png = icons.get(size);
  const entry = 6 + index * 16;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(resolve(root, 'public/favicon.ico'), Buffer.concat([header, ...faviconSizes.map(size => icons.get(size))]));
