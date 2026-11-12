import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { openModal } from './dialog-focus';
import { Icon } from './Icon';
import { formatMessage, t, useLocale, type MessageText } from './localization';
import { ModalDialog } from './ModalDialog';

type WarningContent = {
  title?: string;
  message?: MessageText;
  children?: ReactNode | ((close: () => void) => ReactNode);
  actions?: (close: () => void) => ReactNode;
};
type WarningDetailsProps = WarningContent & { label?: string };

export function WarningDialog({ title, message, children, actions, close, returnFocus }: WarningContent & {
  close: () => void;
  returnFocus?: HTMLElement | null;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  useLayoutEffect(() => {
    const trigger = returnFocus ?? document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog warning-dialog" aria-labelledby={titleId}
    aria-describedby={message ? messageId : undefined} onDismiss={close}>
    <span className="confirmation-symbol" aria-hidden="true">!</span>
    <h2 id={titleId}>{title ?? t('warning.title')}</h2>
    <div className="warning-dialog-body">
      {message && <p id={messageId}>{formatMessage(message)}</p>}
      {typeof children === 'function' ? children(close) : children}
    </div>
    <div className="actions">
      {actions?.(close)}
      <button type="button" className="secondary" onClick={close}>{t('app.dismiss')}</button>
    </div>
  </ModalDialog>, document.body);
}

/** Keep warnings for ongoing conditions available while the user works. */
export function WarningDetails({ label, ...content }: WarningDetailsProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="warning-details">
    <button type="button" ref={trigger} className="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Icon name="ErrorOutline" />
      {label ?? t('warning.review')}
    </button>
    {open && <WarningDialog {...content} returnFocus={trigger.current} close={() => setOpen(false)} />}
  </div>;
}

export function WarningMessages({ messages, ...details }: Pick<WarningDetailsProps, 'actions' | 'label'> & { messages: MessageText[] }) {
  useLocale();
  if (messages.length === 0) return null;
  if (messages.length === 1) return <WarningDetails {...details} message={messages[0]} />;
  return <WarningDetails {...details}>
    <ul className="warning-messages">{messages.map((message, index) => <li key={index}>{formatMessage(message)}</li>)}</ul>
  </WarningDetails>;
}
