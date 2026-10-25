import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

export function LibraryCardMenu({ name, disabled, revision, children }: {
  name: string;
  disabled: boolean;
  revision: number;
  children: ReactNode;
}) {
  useLocale();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open = openedAt === revision && !disabled;
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 0 });
  const label = t('libraries.actions_for', { name });

  function close(restoreFocus = false) {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpenedAt(null);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16;
    const bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 16;
    const below = bottomEdge - rect.bottom - 6;
    const above = rect.top - topEdge - 6;
    const upwards = menu.scrollHeight > below && above > below;
    const maxHeight = Math.max(0, upwards ? above : below);
    setPosition({
      left: Math.max(leftEdge, Math.min(rect.right - menu.offsetWidth, rightEdge - menu.offsetWidth)),
      top: upwards ? rect.top - Math.min(menu.scrollHeight, maxHeight) - 6 : rect.bottom + 6,
      maxHeight,
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });

    const outside = (event: Event) => {
      if (event.target instanceof Node && !button.contains(event.target) && !menu.contains(event.target)) close();
    };
    const dismiss = () => close(menu.contains(document.activeElement));
    // Capture nested Library scrolling as well as window scrolling. Wheel/touch
    // close at gesture start, before momentum can detach the panel from its card.
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('wheel', dismiss, { passive: true });
    window.addEventListener('touchmove', dismiss, { passive: true });
    window.addEventListener('resize', dismiss);
    viewport?.addEventListener('resize', dismiss);
    viewport?.addEventListener('scroll', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('wheel', dismiss);
      window.removeEventListener('touchmove', dismiss);
      window.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('scroll', dismiss);
    };
  }, [open, label]);

  return <>
    <button ref={trigger} type="button" className="quiet library-card-more" disabled={disabled}
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpenedAt(revision)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpenedAt(revision);
        }
      }}><Icon name="MoreHorizontal" /></button>
    {open && createPortal(<div ref={panel} id={id} role="menu" aria-label={label}
      className="library-card-menu floating-controls" style={position}
      onClickCapture={event => {
        if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) {
          // Restore the surviving trigger before an action opens a dialog, so
          // that dialog can return focus after this transient panel disappears.
          trigger.current?.focus({ preventScroll: true });
        }
      }}
      onClick={() => close()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === 'Tab') {
          close(true);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const active = buttons.findIndex(button => button === document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (active + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus({ preventScroll: true });
        }
      }}>{children}</div>, document.body)}
  </>;
}
