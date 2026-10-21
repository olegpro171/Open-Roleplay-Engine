import { message } from './localization.js';
import { MessageError } from './localization.js';
import { z } from 'zod';

export const pictureLimits = { bytes: 10_000_000, pixels: 40_000_000, edge: 16_384, frames: 256, previewEdge: 1600, thumbEdge: 320, previewBytes: 12_000_000, thumbBytes: 600_000, concurrent: 2, queued: 8, durationMs: 15_000 } as const;
export const pictureBase64Limit = 4 * Math.ceil(pictureLimits.bytes / 3);
export const pictureBase64Schema = z.string().min(4).max(pictureBase64Limit).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid base64 file data.').refine(value => value.length % 4 === 0, 'Invalid base64 file length.');
export const cropSchema = z.object({ version: z.literal(1), x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).strict();
export type PictureCrop = z.infer<typeof cropSchema>;
export type PictureDimensions = { width: number; height: number };
export type PixelCrop = { left: number; top: number; width: number; height: number };
const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** v1: oriented source pixels, integer square side/offsets rounded to nearest pixel. */
export function cropFromControls(image: PictureDimensions, zoom = 1, horizontal = 50, vertical = 50): PictureCrop {
  const side = Math.max(1, Math.round(Math.min(image.width, image.height) / bounded(zoom, 1, 4)));
  const left = Math.round((image.width - side) * bounded(horizontal, 0, 100) / 100);
  const top = Math.round((image.height - side) * bounded(vertical, 0, 100) / 100);
  return { version: 1, x: left / image.width, y: top / image.height, width: side / image.width, height: side / image.height };
}
export function cropPixels(image: PictureDimensions, input: PictureCrop): PixelCrop {
  const crop = cropSchema.parse(input);
  const width = crop.width * image.width, height = crop.height * image.height;
  const side = Math.round(width), left = Math.round(crop.x * image.width), top = Math.round(crop.y * image.height);
  if (Math.abs(width - height) > 0.00001 || side < Math.max(1, Math.round(Math.min(image.width, image.height) / 4)) || side > Math.min(image.width, image.height) || left + side > image.width || top + side > image.height || crop.x + crop.width > 1.000000001 || crop.y + crop.height > 1.000000001) throw new MessageError(message("importErrors.crop_must_be_a_bounded_square_between_1"));
  return { left, top, width: side, height: side };
}
export function cropControls(image: PictureDimensions, crop: PictureCrop) {
  const pixels = cropPixels(image, crop);
  return { zoom: Math.min(4, Math.min(image.width, image.height) / pixels.width), horizontal: image.width === pixels.width ? 50 : pixels.left / (image.width - pixels.width) * 100, vertical: image.height === pixels.height ? 50 : pixels.top / (image.height - pixels.height) * 100 };
}
export const pictureMutationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('remove') }).strict(),
  z.object({ mode: z.literal('keep'), key: z.string().uuid(), crop: cropSchema }).strict(),
  z.object({ mode: z.literal('replace'), base64: pictureBase64Schema, crop: cropSchema }).strict(),
]);
export type PictureMutation = z.infer<typeof pictureMutationSchema>;
export type CharacterPicture = PictureDimensions & { characterId: string; key: string; revision: number; crop: PictureCrop; thumbnailUrl: string; previewUrl: string; originalUrl: string };
export type PictureAnalysis = PictureDimensions & { crop: PictureCrop; preview: string; thumbnail: string; firstFrame: boolean };
export type PictureReview = { status: 'none' } | { status: 'ready'; image: PictureAnalysis } | { status: 'error'; message: string };
export const pictureModeSchema = z.enum(['retain', 'none']);
export type PictureImportIntent = { mode: z.infer<typeof pictureModeSchema>; digest: string | null };
