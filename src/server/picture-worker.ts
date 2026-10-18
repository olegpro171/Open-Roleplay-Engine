import sharp from 'sharp';
import { z } from 'zod';
import { cropFromControls, cropPixels, cropSchema, pictureLimits } from '../shared/pictures.js';

sharp.cache(false);
sharp.concurrency(1);
const inputSchema = z.object({ bytes: z.instanceof(Buffer), crop: cropSchema.optional() });
process.once('message', async (message: unknown) => {
  try {
    const { bytes, crop: requested } = inputSchema.parse(message);
    if (!bytes.length || bytes.length > pictureLimits.bytes) throw new Error('Choose a picture of at most 10 MB.');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) throw new Error('Choose a PNG, JPEG or WebP raster picture.');
    let animationFrames = 1, firstImageIsAnimationFrame = false;
    if (png) {
      let seenImage = false;
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        if (offset + 12 + length > bytes.length) throw new Error('Choose an intact PNG picture.');
        if (type === 'acTL' && length === 8) animationFrames = bytes.readUInt32BE(offset + 8);
        if (type === 'fcTL' && !seenImage) firstImageIsAnimationFrame = true;
        if (type === 'IDAT') seenImage = true;
        offset += length + 12;
      }
      if (animationFrames > 1 && !firstImageIsAnimationFrame) throw new Error('Choose an APNG whose default image is its first animation frame, or a static PNG.');
      if (animationFrames > pictureLimits.frames) throw new Error('Pictures must contain at most 256 frames.');
    }
    const options = { failOn: 'warning' as const, limitInputPixels: pictureLimits.pixels, pages: 1, page: 0 };
    const meta = await sharp(bytes, options).metadata();
    if (meta.format !== (png ? 'png' : jpeg ? 'jpeg' : 'webp')) throw new Error('The picture signature and decoded format disagree.');
    const sourceHeight = meta.pageHeight ?? meta.height;
    if (!meta.width || !sourceHeight || Math.max(meta.width, sourceHeight) > pictureLimits.edge || meta.width * sourceHeight > pictureLimits.pixels || (meta.pages ?? 1) > pictureLimits.frames) throw new Error('Pictures must be at most 40 million pixels, 16,384 pixels per edge and 256 frames.');
    // Decode once to oriented sRGB pixels; both renditions use this exact source.
    const oriented = await sharp(bytes, options).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = oriented.info.width, height = oriented.info.height;
    const crop = requested ?? cropFromControls({ width, height });
    const rectangle = cropPixels({ width, height }, crop);
    const raw = { width, height, channels: 4 as const };
    const preview = await sharp(oriented.data, { raw }).resize({ width: pictureLimits.previewEdge, height: pictureLimits.previewEdge, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer();
    const thumbnail = await sharp(oriented.data, { raw }).extract(rectangle).resize(pictureLimits.thumbEdge, pictureLimits.thumbEdge).png({ compressionLevel: 6 }).toBuffer();
    if (preview.length > pictureLimits.previewBytes || thumbnail.length > pictureLimits.thumbBytes) throw new Error('The generated picture exceeds the rendition size limit. Choose a simpler or smaller picture.');
    process.send?.({ ok: true, width, height, orientation: meta.orientation ?? 1, mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp', firstFrame: animationFrames > 1 || (meta.pages ?? 1) > 1 || Boolean(meta.loop !== undefined), crop, preview, thumbnail });
  } catch (error) {
    // Decoder details can include private metadata; only domain validation is public.
    const message = error instanceof Error && (/^(Choose|Pictures must|Crop must|The generated|The picture signature)/).test(error.message) ? error.message : 'This picture could not be decoded completely. Choose an intact PNG, JPEG or WebP file.';
    process.send?.({ ok: false, message });
  }
});
