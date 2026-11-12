import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
import { formatMessage, LocalizedError, t, message as msg, useLocale } from './localization';
import type { LocalizedMessage } from '../shared/localization';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ConfirmationText = string | LocalizedMessage;
export type ConfirmationCopy = { title: ConfirmationText; message: ConfirmationText; actionLabel: ConfirmationText; confirmOnEnter?: true };
type Confirmation = ConfirmationCopy & { cancelLabel?: ConfirmationText; details?: ReactNode; returnFocus?: HTMLElement; onConfirm: () => void };
type Request = Confirmation & { owner: string };
type ConfirmationControl = { open: (request: Request) => void; dismiss: (owner: string) => void };
const ConfirmationContext = createContext<ConfirmationControl | null>(null);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [request, setRequest] = useState<Request | null>(null);
  const active = useRef<Request | null>(null);
  const open = useCallback((next: Request) => {
    if (active.current) return;
    active.current = next;
    setRequest(next);
  }, []);
  const dismiss = useCallback((owner: string) => {
    if (active.current?.owner !== owner) return;
    active.current = null;
    setRequest(null);
  }, []);
  const control = useMemo(() => ({ open, dismiss }), [open, dismiss]);
  return <ConfirmationContext.Provider value={control}>{children}{request && <ConfirmationDialog request={request} cancel={() => dismiss(request.owner)} confirm={() => {
    // Clear ownership before executing: repeated clicks cannot repeat a command.
    if (active.current !== request) return;
    dismiss(request.owner);
    request.onConfirm();
  }} />}</ConfirmationContext.Provider>;
}

export function useConfirmation(scope?: string | null) {
  const control = useContext(ConfirmationContext);
  const owner = useId();
  if (!control) throw new LocalizedError(msg("confirmation.confirmationprovider_is_missing"));
  useEffect(() => () => control.dismiss(owner), [control, owner, scope]);
  return (request: Confirmation) => control.open({ ...request, owner });
}

function ConfirmationDialog({ request, cancel, confirm }: { request: Confirmation; cancel: () => void; confirm: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId();
  useLayoutEffect(() => openModal(dialog.current, request.returnFocus), []);
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog" aria-labelledby={title} aria-describedby={description} onDismiss={cancel} onKeyDown={event => {
    if (request.confirmOnEnter && event.key === 'Enter' && event.target !== cancelButton.current) {
      event.preventDefault();
      if (!event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) confirm();
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep keyboard traversal on the two choices, including at the modal boundaries.
    event.preventDefault();
    const active = document.activeElement;
    let next: HTMLButtonElement | null;
    if (active === cancelButton.current) next = confirmButton.current;
    else if (active === confirmButton.current) next = cancelButton.current;
    else next = event.shiftKey ? confirmButton.current : cancelButton.current;
    next?.focus();
  }}>
    <span className="confirmation-symbol" aria-hidden="true">!</span>
    <h2 id={title}>{formatMessage(request.title)}</h2>
    <p id={description}>{formatMessage(request.message)}</p>
    {request.details}
    <div className="actions"><button type="button" ref={cancelButton} className="secondary" onClick={cancel}>{request.cancelLabel ? formatMessage(request.cancelLabel) : t("character_import.cancel")}</button><button type="button" ref={confirmButton} className="danger" onClick={confirm} aria-keyshortcuts={request.confirmOnEnter ? 'Enter' : undefined}>{formatMessage(request.actionLabel)}</button></div>
  </ModalDialog>, document.body);
}
