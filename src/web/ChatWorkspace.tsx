import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export const ChatDetailsTarget = createContext<HTMLDivElement | null>(null);

export function ChatWorkspace({ sidebar, actions, navigation = false, children }: { sidebar: ReactNode; actions: ReactNode; navigation?: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const target = useContext(ChatDetailsTarget);
  const toggle = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      // Prompt peek owns focus while its modal is above this disclosure.
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      if (event.target instanceof Node && !toggle.current?.contains(event.target) && !details.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      setExpanded(false);
      toggle.current?.focus();
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
  }, [expanded]);
  const pageActions = <div className="chat-page-actions">{actions}</div>;
  return <main className="story-layout">
    {target && createPortal(<button ref={toggle} type="button" className="quiet chat-details-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)} onKeyDown={event => {
      if (expanded && event.key === 'Tab' && !event.shiftKey) {
        const first = details.current?.querySelector<HTMLElement>('summary, button:not(:disabled)');
        if (first) { event.preventDefault(); first.focus(); }
      }
    }}>Chat details <Icon name={expanded ? 'ArrowShortTop' : 'ArrowShortBottom'} /></button>, target)}
    <aside className={`story-meta${navigation ? ' story-navigation' : ''}`} aria-label="Current chat">
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
