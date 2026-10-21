import { useEffect, useId, useRef, useState } from 'react';
import { cropControls, cropFromControls, cropPixels, pictureLimits, type CharacterPicture, type PictureAnalysis, type PictureCrop, type PictureDimensions, type PictureMutation } from '../shared/pictures';
import { api } from './api';

export type PictureDraft = (PictureDimensions & { crop: PictureCrop; preview: string } & ({ origin: 'saved'; key: string } | { origin: 'local'; base64: string; savedKey?: string })) | null;
export function savedPictureDraft(picture: CharacterPicture | null): PictureDraft {
  return picture ? { origin: 'saved', key: picture.key, width: picture.width, height: picture.height, crop: picture.crop, preview: picture.previewUrl } : null;
}
export function pictureMutation(draft: PictureDraft, baseline: CharacterPicture | null): PictureMutation | undefined {
  if (!draft) return baseline ? { mode: 'remove' } : undefined;
  if (draft.origin === 'local' && draft.savedKey === baseline?.key && JSON.stringify(draft.crop) === JSON.stringify(baseline?.crop)) return undefined;
  if (draft.origin === 'local') return { mode: 'replace', base64: draft.base64, crop: draft.crop };
  return JSON.stringify(draft.crop) === JSON.stringify(baseline?.crop) && draft.key === baseline?.key ? undefined : { mode: 'keep', key: draft.key, crop: draft.crop };
}
export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export function PictureSquare({ url, label = 'No picture' }: { url?: string; label?: string }) {
  return <Picture url={url} label={label} shape="square" />;
}
export function CharacterAvatar({ url }: { url?: string }) {
  return <Picture url={url} label="No picture" shape="round" />;
}
function Picture({ url, label, shape }: { url?: string; label: string; shape: 'square' | 'round' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={shape === 'round' ? 'character-avatar' : 'picture-square'} aria-hidden="true">{url && !failed ? <img key={url} src={url} alt="" loading="lazy" decoding="async" width="320" height="320" onError={() => setFailed(true)} /> : <span className="picture-placeholder"><svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="20" cy="14" r="6" /><path d="M8 34c0-15 24-15 24 0" /></svg><span>{failed ? 'Picture unavailable' : label}</span></span>}</div>;
}
export function CroppedPicture({ image, crop = image.crop }: { image: PictureDimensions & { preview: string; crop: PictureCrop }; crop?: PictureCrop }) {
  const region = cropPixels(image, crop);
  return <svg className="cropped-picture" viewBox={`${region.left} ${region.top} ${region.width} ${region.height}`} aria-hidden="true"><image href={image.preview} width={image.width} height={image.height} preserveAspectRatio="none" /></svg>;
}
export function PictureEditor({ value, change, original, disabled, processing }: { value: PictureDraft; change: (value: PictureDraft) => void; original: CharacterPicture | null; disabled: boolean; processing: (value: boolean) => void }) {
  const [cropOpen, setCropOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('');
  const cropTrigger = useRef<HTMLButtonElement>(null);
  const attempt = useRef(0), abort = useRef<AbortController | null>(null);
  useEffect(() => () => { attempt.current++; abort.current?.abort(); }, []);
  return <section className="full picture-editor" aria-label="Character picture"><div className="picture-editor-square">{value ? <CroppedPicture image={value} /> : <PictureSquare />}</div><div className="picture-editor-controls"><div className="actions">
    <label className={`file-button${disabled || working ? ' disabled' : ''}`}>{value ? 'Replace picture' : 'Choose picture'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={value ? 'Replace picture' : 'Choose picture'} disabled={disabled || working} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      setWorking(true); processing(true); setError('');
      try {
        if (file.size > pictureLimits.bytes) throw new Error('Pictures are limited to 10 MB.');
        const base64 = await fileBase64(file);
        if (current !== attempt.current) return;
        const image = await api<PictureAnalysis>('/pictures/preview', 'POST', { base64 }, controller.signal);
        if (current === attempt.current) change({ origin: 'local', base64, width: image.width, height: image.height, crop: image.crop, preview: image.preview });
      } catch (error) { if (current === attempt.current) setError(error instanceof Error ? error.message : 'Could not read this picture.'); }
      finally { if (current === attempt.current) { setWorking(false); processing(false); } }
    }} /></label>
    {value && <><button ref={cropTrigger} type="button" className="secondary" disabled={disabled || working} onClick={async () => {
      if (value.origin === 'local') { setCropOpen(true); return; }
      const current = ++attempt.current, controller = new AbortController(); abort.current?.abort(); abort.current = controller;
      setWorking(true); processing(true); setError('');
      try {
        if (!original || original.key !== value.key) throw new Error('The saved source changed. Choose its original picture again.');
        const response = await fetch(original.originalUrl, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('Could not load the saved original. Refresh the character before adjusting its crop.');
        const base64 = await fileBase64(new File([await response.blob()], 'original'));
        const previewResponse = await fetch(value.preview, { credentials: 'same-origin', signal: controller.signal });
        if (!previewResponse.ok) throw new Error('Could not load the working preview. Try again.');
        const preview = `data:image/png;base64,${await fileBase64(new File([await previewResponse.blob()], 'preview'))}`;
        if (current === attempt.current) { change({ origin: 'local', base64, savedKey: value.key, width: value.width, height: value.height, preview, crop: value.crop }); setCropOpen(true); }
      } catch (error) { if (current === attempt.current) setError(error instanceof Error ? error.message : 'Could not prepare this crop.'); }
      finally { if (current === attempt.current) { setWorking(false); processing(false); } }
    }}>Adjust crop</button><button type="button" className="quiet" disabled={disabled || working} onClick={() => { change(null); setError(''); }}>Remove picture</button></>}
  </div>{value && Math.min(value.width, value.height) < pictureLimits.thumbEdge && <p className="small muted">Small original: enlarging it cannot add detail.</p>}
  <p className="small muted">PNG, JPEG or WebP · up to 10 MB. Animated pictures display the first frame.</p>
  {working && <p role="status">Validating and preparing picture…</p>}{error && <p role="alert">{error} Your previous picture draft is retained.</p>}</div>
  {cropOpen && value && <CropDialog focusTarget={cropTrigger.current} image={value} close={() => setCropOpen(false)} apply={crop => { change({ ...value, crop }); setCropOpen(false); }} />}</section>;
}
export function CropDialog({ image, close, apply, focusTarget }: { focusTarget?: HTMLElement | null; image: NonNullable<PictureDraft>; close: () => void; apply: (crop: PictureCrop) => void }) {
  const [crop, setCrop] = useState(image.crop), dialog = useRef<HTMLDialogElement>(null), zoomInput = useRef<HTMLInputElement>(null), title = useId();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; side: number; screen: number } | null>(null);
  useEffect(() => {
    const opener = focusTarget ?? document.activeElement, node = dialog.current; node?.showModal(); zoomInput.current?.focus();
    return () => { node?.close(); if (opener instanceof HTMLElement) opener.focus(); };
  }, [focusTarget]);
  const controls = cropControls(image, crop), region = cropPixels(image, crop);
  function update(values: Partial<typeof controls>) { const next = { ...controls, ...values }; setCrop(cropFromControls(image, next.zoom, next.horizontal, next.vertical)); }
  return <dialog ref={dialog} className="crop-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); close(); }}><h2 id={title}>Adjust picture crop</h2><p className="small muted">Drag to frame your picture, or use the controls below. Changes stay in the character draft until Save character.</p>
    <div className="crop-surface" onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: region.left, top: region.top, side: region.width, screen: event.currentTarget.clientWidth };
    }} onPointerMove={event => {
      const start = drag.current; if (!start || start.id !== event.pointerId) return;
      const left = Math.max(0, Math.min(image.width - start.side, start.left - (event.clientX - start.x) * start.side / start.screen));
      const top = Math.max(0, Math.min(image.height - start.side, start.top - (event.clientY - start.y) * start.side / start.screen));
      setCrop(cropFromControls(image, controls.zoom, image.width === start.side ? 50 : left / (image.width - start.side) * 100, image.height === start.side ? 50 : top / (image.height - start.side) * 100));
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}><CroppedPicture image={image} crop={crop} /><div className="crop-grid" /></div>
    <div className="crop-controls"><label>Zoom <output>{controls.zoom.toFixed(2)}×</output><input ref={zoomInput} type="range" aria-label="Zoom" min="1" max="4" step="0.01" value={controls.zoom} onChange={event => update({ zoom: Number(event.target.value) })} /></label>
      <label>Horizontal position <output>{image.width === region.width ? 'Centered · no horizontal travel' : `${Math.round(controls.horizontal)}%`}</output><input type="range" aria-label="Horizontal position" min="0" max="100" step="1" disabled={image.width === region.width} value={controls.horizontal} onChange={event => update({ horizontal: Number(event.target.value) })} /></label>
      <label>Vertical position <output>{image.height === region.height ? 'Centered · no vertical travel' : `${Math.round(controls.vertical)}%`}</output><input type="range" aria-label="Vertical position" min="0" max="100" step="1" disabled={image.height === region.height} value={controls.vertical} onChange={event => update({ vertical: Number(event.target.value) })} /></label></div>
    <div className="actions crop-footer"><button type="button" className="secondary" onClick={() => setCrop(cropFromControls(image))}>Reset crop</button><button type="button" onClick={() => apply(crop)}>Use crop</button><button type="button" className="quiet" onClick={close}>Cancel</button></div>
  </dialog>;
}
