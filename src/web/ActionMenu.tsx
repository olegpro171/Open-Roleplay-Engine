import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export function ActionMenu({ label, disabled, revision = null, focusMode = 'item', children }: {
  label: string;
  disabled: boolean;
  revision?: number | null;
  focusMode?: 'item' | 'panel';
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [openedAt, setOpenedAt] = useState<number | null>();
  const open = openedAt === revision && !disabled;
  if (openedAt !== undefined && !open) setOpenedAt(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 0 });

  function close(restoreFocus = false) {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpenedAt(undefined);
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
    const initialFocus = focusMode === 'panel' ? menu : menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
    initialFocus?.focus({ preventScroll: true });

    const outside = (event: Event) => {
      if (event.target instanceof Node && !button.contains(event.target) && !menu.contains(event.target)) close();
    };
    const modal = button.closest('dialog[open]');
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      // Story can scroll behind a modal as streamed text arrives.
      if (modal && event.target instanceof Element && !modal.contains(event.target)) return;
      close(menu.contains(document.activeElement));
    };
    // Capture nested scrolling too. Wheel/touch close at gesture start,
    // before momentum can detach the panel from its trigger.
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
  }, [open, label, focusMode]);

  // A modal makes content outside its own tree inert, including body portals.
  const menuHost = open ? trigger.current?.closest('dialog[open]') ?? document.body : null;
  return <>
    <button ref={trigger} type="button" className="quiet action-menu-trigger" disabled={disabled}
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setOpenedAt(revision)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpenedAt(revision);
        }
      }}><Icon name="MoreHorizontal" /></button>
    {menuHost && createPortal(<div ref={panel} id={id} role="menu" aria-label={label}
      className="action-menu floating-controls" style={position} tabIndex={focusMode === 'panel' ? -1 : undefined}
      onClickCapture={event => {
        if (focusMode === 'item' && event.target instanceof Element && event.target.closest('button:not(:disabled)')) {
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
          const next = event.key === 'Home' ? 0
            : event.key === 'End' || (event.key === 'ArrowUp' && active < 0) ? buttons.length - 1
            : (active + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus({ preventScroll: true });
        }
      }}>{children}</div>, menuHost)}
  </>;
}
