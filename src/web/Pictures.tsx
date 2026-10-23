import { openModal } from './dialog-focus';
import { LocalizedError, useTextState, errorText, t, message as msg, useLocale } from './localization';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
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
export function PictureSquare({ url, label = t("pictures.no_picture") }: { url?: string; label?: string }) {
  useLocale();
  return <Picture url={url} label={label} shape="square" />;
}
export function CharacterAvatar({ url }: { url?: string }) {
  useLocale();
  return <Picture url={url} label={t("pictures.no_picture")} shape="round" />;
}
export function ChatCharacterPortrait({ picture }: { picture?: CharacterPicture }) {
  useLocale();
  const [open, setOpen] = useState(false);
  if (!picture) return null;
  return <div className="chat-character-portrait">
    <button type="button" className="portrait-button" aria-label={t("pictures.view_original")} onClick={() => setOpen(true)}><CharacterAvatar url={picture.thumbnailUrl} /></button>
    {open && <OriginalPictureViewer picture={picture} close={() => setOpen(false)} />}
  </div>;
}
function OriginalPictureViewer({ picture, close }: { picture: CharacterPicture; close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    const opener = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="original-picture-viewer" aria-label={t("pictures.original_picture")} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <button type="button" className="quiet" aria-label={t("reasoning.close")} title={t("reasoning.close")} onClick={close}><Icon name="Close" /></button>
    {status === 'loading' && <p role="status">{t("pictures.loading_original")}</p>}
    {status === 'failed' ? <p role="alert">{t("pictures.original_unavailable")}</p> : <img src={picture.originalUrl} alt={t("pictures.original_picture")} style={{ width: `min(100%, calc((100dvh - 32px) * ${picture.width / picture.height}))` }} onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
  </dialog>, document.body);
}
function Picture({ url, label, shape }: { url?: string; label: string; shape: 'square' | 'round' }) {
  useLocale();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={shape === 'round' ? 'character-avatar' : 'picture-square'} aria-hidden="true">{url && !failed ? <img key={url} src={url} alt="" loading="lazy" decoding="async" width="320" height="320" onError={() => setFailed(true)} /> : <span className="picture-placeholder"><svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="20" cy="14" r="6" /><path d="M8 34c0-15 24-15 24 0" /></svg><span>{failed ? t("pictures.picture_unavailable") : label}</span></span>}</div>;
}
export function CroppedPicture({ image, crop = image.crop }: { image: PictureDimensions & { preview: string; crop: PictureCrop }; crop?: PictureCrop }) {
  useLocale();
  const region = cropPixels(image, crop);
  return <svg className="cropped-picture" viewBox={`${region.left} ${region.top} ${region.width} ${region.height}`} aria-hidden="true"><image href={image.preview} width={image.width} height={image.height} preserveAspectRatio="none" /></svg>;
}
export function PictureEditor({ value, change, original, disabled, processing }: { value: PictureDraft; change: (value: PictureDraft) => void; original: CharacterPicture | null; disabled: boolean; processing: (value: boolean) => void }) {
  useLocale();
  const [cropOpen, setCropOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useTextState('');
  const cropTrigger = useRef<HTMLButtonElement>(null);
  const attempt = useRef(0), abort = useRef<AbortController | null>(null);
  useEffect(() => () => { attempt.current++; abort.current?.abort(); }, []);
  return <section className="full picture-editor" aria-label={t("pictures.character_picture")}><div className="picture-editor-square">{value ? <CroppedPicture image={value} /> : <PictureSquare />}</div><div className="picture-editor-controls"><div className="actions">
    <label className={`file-button${disabled || working ? ' disabled' : ''}`}>{value ? t("pictures.replace_picture") : t("pictures.choose_picture")}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={value ? t("pictures.replace_picture") : t("pictures.choose_picture")} disabled={disabled || working} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      setWorking(true); processing(true); setError('');
      try {
        if (file.size > pictureLimits.bytes) throw new LocalizedError(msg("pictures.pictures_are_limited_to_10_mb"));
        const base64 = await fileBase64(file);
        if (current !== attempt.current) return;
        const image = await api<PictureAnalysis>('/pictures/preview', 'POST', { base64 }, controller.signal);
        if (current === attempt.current) change({ origin: 'local', base64, width: image.width, height: image.height, crop: image.crop, preview: image.preview });
      } catch (error) { if (current === attempt.current) setError(errorText(error, msg("pictures.could_not_read_this_picture"))); }
      finally { if (current === attempt.current) { setWorking(false); processing(false); } }
    }} /></label>
    {value && <><button ref={cropTrigger} type="button" className="secondary" disabled={disabled || working} onClick={async () => {
      if (value.origin === 'local') { setCropOpen(true); return; }
      const current = ++attempt.current, controller = new AbortController(); abort.current?.abort(); abort.current = controller;
      setWorking(true); processing(true); setError('');
      try {
        if (!original || original.key !== value.key) throw new LocalizedError(msg("pictures.the_saved_source_changed_choose_its_original"));
        const response = await fetch(original.originalUrl, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new LocalizedError(msg("pictures.could_not_load_the_saved_original_refresh"));
        const base64 = await fileBase64(new File([await response.blob()], 'original'));
        const previewResponse = await fetch(value.preview, { credentials: 'same-origin', signal: controller.signal });
        if (!previewResponse.ok) throw new LocalizedError(msg("pictures.could_not_load_the_working_preview_try"));
        const preview = `data:image/png;base64,${await fileBase64(new File([await previewResponse.blob()], 'preview'))}`;
        if (current === attempt.current) { change({ origin: 'local', base64, savedKey: value.key, width: value.width, height: value.height, preview, crop: value.crop }); setCropOpen(true); }
      } catch (error) { if (current === attempt.current) setError(errorText(error, msg("pictures.could_not_prepare_this_crop"))); }
      finally { if (current === attempt.current) { setWorking(false); processing(false); } }
    }}>{t("pictures.adjust_crop")}</button><button type="button" className="quiet" disabled={disabled || working} onClick={() => { change(null); setError(''); }}>{t("pictures.remove_picture")}</button></>}
  </div>{value && Math.min(value.width, value.height) < pictureLimits.thumbEdge && <p className="small muted">{t("pictures.small_original_enlarging_it_cannot_add_detail")}</p>}
  <p className="small muted">{t("pictures.png_jpeg_or_webp_up_to_10")}</p>
  {working && <p role="status">{t("pictures.validating_and_preparing_picture")}</p>}{error && <p role="alert">{t("pictures.your_previous_picture_draft_is_retained", { error: error })}</p>}</div>
  {cropOpen && value && <CropDialog focusTarget={cropTrigger.current} image={value} close={() => setCropOpen(false)} apply={crop => { change({ ...value, crop }); setCropOpen(false); }} />}</section>;
}
export function CropDialog({ image, close, apply, focusTarget }: { focusTarget?: HTMLElement | null; image: NonNullable<PictureDraft>; close: () => void; apply: (crop: PictureCrop) => void }) {
  useLocale();
  const [crop, setCrop] = useState(image.crop), dialog = useRef<HTMLDialogElement>(null), title = useId();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; side: number; screen: number } | null>(null);
  useEffect(() => {
    const opener = focusTarget ?? document.activeElement, node = dialog.current; openModal(node);
    return () => { node?.close(); if (opener instanceof HTMLElement) opener.focus(); };
  }, [focusTarget]);
  const controls = cropControls(image, crop), region = cropPixels(image, crop);
  function update(values: Partial<typeof controls>) { const next = { ...controls, ...values }; setCrop(cropFromControls(image, next.zoom, next.horizontal, next.vertical)); }
  return <dialog ref={dialog} className="crop-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); close(); }}><h2 id={title}>{t("pictures.adjust_picture_crop")}</h2><p className="small muted">{t("pictures.drag_to_frame_your_picture_or_use")}</p>
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
    <div className="crop-controls"><label>{t("pictures.zoom")}<output>{controls.zoom.toFixed(2)}×</output><input type="range" aria-label={t("pictures.zoom_2")} min="1" max="4" step="0.01" value={controls.zoom} onChange={event => update({ zoom: Number(event.target.value) })} /></label>
      <label>{t("pictures.horizontal_position")}<output>{image.width === region.width ? t("pictures.centered_no_horizontal_travel") : `${Math.round(controls.horizontal)}%`}</output><input type="range" aria-label={t("pictures.horizontal_position_2")} min="0" max="100" step="1" disabled={image.width === region.width} value={controls.horizontal} onChange={event => update({ horizontal: Number(event.target.value) })} /></label>
      <label>{t("pictures.vertical_position")}<output>{image.height === region.height ? t("pictures.centered_no_vertical_travel") : `${Math.round(controls.vertical)}%`}</output><input type="range" aria-label={t("pictures.vertical_position_2")} min="0" max="100" step="1" disabled={image.height === region.height} value={controls.vertical} onChange={event => update({ vertical: Number(event.target.value) })} /></label></div>
    <div className="actions crop-footer"><button type="button" className="secondary" onClick={() => setCrop(cropFromControls(image))}>{t("pictures.reset_crop")}</button><button type="button" onClick={() => apply(crop)}>{t("pictures.use_crop")}</button><button type="button" className="quiet" onClick={close}>{t("character_import.cancel")}</button></div>
  </dialog>;
}
