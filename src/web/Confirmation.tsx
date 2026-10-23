import { openModal } from './dialog-focus';
import { LocalizedError, t, message as msg, useLocale } from './localization';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Confirmation = { title: string; message: string; actionLabel: string; onConfirm: () => void };
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
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" aria-labelledby={title} aria-describedby={description} onCancel={event => { event.preventDefault(); cancel(); }} onKeyDown={event => {
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
    <h2 id={title}>{request.title}</h2>
    <p id={description}>{request.message}</p>
    <div className="actions"><button type="button" ref={cancelButton} className="secondary" onClick={cancel}>{t("character_import.cancel")}</button><button type="button" ref={confirmButton} className="danger" onClick={confirm}>{request.actionLabel}</button></div>
  </dialog>, document.body);
}
