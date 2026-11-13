import { t, useLocale } from './localization';
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { popupInput, restorePopupFocusAfterEscape, type PopupInput } from './popup-input';

export const ChatDetailsTarget = createContext<HTMLDivElement | null>(null);

export function useReturnToChatOnEscape(returnToChat: (() => void) | undefined) {
  useEffect(() => {
    if (!returnToChat) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      // Controls and the Chat details disclosure handle Escape before it reaches window.
      // Native dialogs use the browser's cancel event after keydown.
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      returnToChat();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [returnToChat]);
}

type ChatWorkspaceProps = {
  sidebar: ReactNode;
  actions: ReactNode;
  dismissDetails?: boolean;
  children: ReactNode;
} & (
  | { navigation: true; returnToChat?: never }
  | { navigation?: false; returnToChat: (() => void) | undefined }
);

export function ChatWorkspace({ sidebar, actions, navigation = false, dismissDetails = false, returnToChat, children }: ChatWorkspaceProps) {
  useLocale();
  useReturnToChatOnEscape(returnToChat);
  const [expanded, setExpanded] = useState(false);
  const openedWith = useRef<PopupInput>('keyboard');
  const detailsId = useId();
  const target = useContext(ChatDetailsTarget);
  const toggle = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    if (dismissDetails) {
      setExpanded(false);
      toggle.current?.focus({ preventScroll: true });
      return;
    }
    const outside = (event: Event) => {
      // Prompt peek owns focus while its modal is above this disclosure.
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      if (!(event.target instanceof Node)) return;
      // Keep the backdrop in place until it receives the click that dismisses the panel.
      if (backdrop.current?.contains(event.target) || toggle.current?.contains(event.target) || details.current?.contains(event.target)) return;
      setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setExpanded(false);
      restorePopupFocusAfterEscape(toggle.current, openedWith.current);
    };
    const wide = window.matchMedia('(min-width: 801px)');
    const resize = (event: MediaQueryListEvent) => { if (event.matches) setExpanded(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    wide.addEventListener('change', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      wide.removeEventListener('change', resize);
    };
  }, [expanded, dismissDetails]);
  const pageActions = <div className={`chat-page-actions${navigation ? '' : ' editor-actions floating-controls'}`}>{actions}</div>;
  return <main className="story-layout">
    {target && createPortal(<button ref={toggle} type="button" className="quiet chat-details-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => {
      if (!expanded) openedWith.current = popupInput();
      setExpanded(!expanded);
    }} onKeyDown={event => {
      if (expanded && event.key === 'Tab' && !event.shiftKey) {
        const first = details.current?.querySelector<HTMLElement>('summary, button:not(:disabled)');
        if (first) { event.preventDefault(); first.focus(); }
      }
    }}>{t("chat_workspace.chat_details")}<Icon name={expanded ? 'ArrowShortTop' : 'ArrowShortBottom'} /></button>, target)}
    {expanded && <div ref={backdrop} className="chat-details-backdrop" aria-hidden="true" onClick={() => {
      setExpanded(false);
      toggle.current?.focus({ preventScroll: true });
    }} />}
    <aside className={`story-meta${navigation ? ' story-navigation' : ''}`} aria-label={t("chat_workspace.current_chat")}>
      <div ref={details} id={detailsId} className={`chat-details${expanded ? ' expanded' : ''}`} onKeyDown={event => {
        const first = details.current?.querySelector<HTMLElement>('summary, button:not(:disabled)');
        if (expanded && event.key === 'Tab' && event.shiftKey && event.target === first) {
          event.preventDefault(); toggle.current?.focus();
        }
      }}>{sidebar}{navigation && pageActions}</div>
      {!navigation && pageActions}
    </aside>
    {children}
  </main>;
}
