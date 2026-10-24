import { useId, useLayoutEffect, useRef, useState, type ChangeEventHandler } from 'react';
import { createPortal } from 'react-dom';
import { openModal } from './dialog-focus';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

/** File selection only; validation and import/recovery remain with the caller. */
export function LibraryImport({ label, inputLabel = label, accept, disabled, onChange }: {
  label: string;
  inputLabel?: string;
  accept: string;
  disabled: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="secondary" disabled={disabled} onClick={() => {
      // Match the Library's existing narrow-layout breakpoint, including rotation.
      if (window.matchMedia('(max-width: 800px)').matches) input.current?.click();
      else setOpen(true);
    }}><Icon name="Import" />{label}</button>
    <input ref={input} type="file" hidden accept={accept} aria-label={inputLabel} disabled={disabled} onChange={event => {
      if (!event.target.files?.length) return;
      setOpen(false);
      onChange(event);
    }} />
    {open && <ImportPopup title={label} disabled={disabled} close={() => setOpen(false)} browse={() => input.current?.click()} drop={files => {
      const node = input.current;
      if (!node || disabled || files.length !== 1) return;
      node.files = files;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }} />}
  </>;
}

function ImportPopup({ title, disabled, close, browse, drop }: {
  title: string;
  disabled: boolean;
  close: () => void;
  browse: () => void;
  drop: (files: FileList) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [dragging, setDragging] = useState(false);
  const [multiple, setMultiple] = useState(false);
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog library-import-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); close(); }}
    onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <div className="library-import-heading"><h2 id={heading}>{title}</h2>
      <button type="button" className="secondary" aria-label={t('library_import.close')} title={t('library_import.close')} onClick={close}><Icon name="Close" /></button>
    </div>
    <button type="button" className={`secondary library-import-drop${dragging ? ' is-dragging' : ''}`} disabled={disabled} onClick={browse}
      onDragEnter={event => { event.preventDefault(); setDragging(true); }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDragging(false); }}
      onDrop={event => {
        event.preventDefault(); setDragging(false);
        if (disabled) return;
        setMultiple(event.dataTransfer.files.length > 1);
        drop(event.dataTransfer.files);
      }}><Icon name="Import" />{t('library_import.drop_here')}</button>
    {multiple && <p role="alert">{t('library_import.one_file')}</p>}
  </dialog>, document.body);
}
