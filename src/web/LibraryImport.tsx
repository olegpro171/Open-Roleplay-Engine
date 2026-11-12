import { useId, useLayoutEffect, useRef, useState, type ChangeEventHandler, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

/** File selection only; validation and import/recovery remain with the caller. */
export function LibraryImport({ label, dialogTitle = label, description, inputLabel = label, accept, disabled, triggerRef, renderTrigger, onChange }: {
  label: string;
  dialogTitle?: string;
  description: string;
  inputLabel?: string;
  accept: string;
  disabled: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  renderTrigger?: (open: () => void) => ReactNode;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  function chooseFile() {
    if (disabled) return;
    // Match the Library's existing narrow-layout breakpoint, including rotation.
    if (window.matchMedia('(max-width: 800px)').matches) input.current?.click();
    else setOpen(true);
  }
  return <>
    {renderTrigger ? renderTrigger(chooseFile) : <button ref={triggerRef} type="button" className="secondary"
      disabled={disabled} onClick={chooseFile}><Icon name="Import" />{label}</button>}
    <input ref={input} type="file" hidden accept={accept} aria-label={inputLabel} disabled={disabled} onChange={event => {
      if (!event.target.files?.length) return;
      setOpen(false);
      onChange(event);
    }} />
    {open && <ImportPopup title={dialogTitle} description={description} formats={accept.split(',').map(value => value.trim()).filter(value => value.startsWith('.')).join(', ').toUpperCase()} disabled={disabled} close={() => setOpen(false)} browse={() => input.current?.click()} drop={files => {
      const node = input.current;
      if (!node || disabled || files.length !== 1) return;
      node.files = files;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }} />}
  </>;
}

function ImportPopup({ title, description, formats, disabled, close, browse, drop }: {
  title: string;
  description: string;
  formats: string;
  disabled: boolean;
  close: () => void;
  browse: () => void;
  drop: (files: FileList) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const descriptionId = useId();
  const dropLabel = useId();
  const formatsId = useId();
  const [dragging, setDragging] = useState(false);
  const [multiple, setMultiple] = useState(false);
  useLayoutEffect(() => openModal(dialog.current), []);
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog library-import-dialog" aria-labelledby={heading} aria-describedby={descriptionId}
    onDismiss={close}
    onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <div className="library-import-heading"><div><h2 id={heading}>{title}</h2>
      <p id={descriptionId}>{description}</p></div>
      <button type="button" className="secondary" aria-label={t('library_import.close')} title={t('library_import.close')} onClick={close}><Icon name="Close" /></button>
    </div>
    <button type="button" className={`secondary library-import-drop${dragging ? ' is-dragging' : ''}`} aria-labelledby={dropLabel} aria-describedby={formatsId} disabled={disabled} onClick={browse}
      onDragEnter={event => { event.preventDefault(); setDragging(true); }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDragging(false); }}
      onDrop={event => {
        event.preventDefault(); setDragging(false);
        if (disabled) return;
        setMultiple(event.dataTransfer.files.length > 1);
        drop(event.dataTransfer.files);
      }}><Icon name="Import" /><span id={dropLabel}>{t('library_import.drop_here')}</span><span id={formatsId} className="small muted">{formats}</span></button>
    {multiple && <p role="alert">{t('library_import.one_file')}</p>}
  </ModalDialog>, document.body);
}
