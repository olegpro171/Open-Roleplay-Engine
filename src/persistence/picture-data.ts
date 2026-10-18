import type { PictureCrop } from '../shared/pictures.js';

/** Validated transient renditions. Original bytes never enter public snapshots or receipts. */
export type PreparedPicture = {
  width: number; height: number; orientation: number; mime: 'image/png' | 'image/jpeg' | 'image/webp';
  firstFrame: boolean; crop: PictureCrop; preview: Buffer; thumbnail: Buffer;
  original: Buffer; digest: string; renditionVersion: number;
};
