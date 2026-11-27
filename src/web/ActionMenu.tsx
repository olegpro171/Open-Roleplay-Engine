import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { capturePopupScroll, popupInput, restorePopupFocusAfterEscape, type PopupInput } from './popup-input';

export function ActionMenu({ label, disabled, revision = null, align = 'end', aboveTrigger = false, bottomBoundaryRef, focusMode = 'item', triggerRef, children }: {
  label: string;
  disabled: boolean;
  revision?: number | null;
  align?: 'start' | 'end';
  aboveTrigger?: boolean;
  bottomBoundaryRef?: RefObject<HTMLElement | null>;
  focusMode?: 'item' | 'panel' | 'editing';
  triggerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const id = useId();
  const internalTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? internalTrigger;
  const panel = useRef<HTMLDivElement>(null);
  const openedWith = useRef<PopupInput>('keyboard');
  const [openedAt, setOpenedAt] = useState<number | null>();
  const open = openedAt === revision && !disabled;
  if (openedAt !== undefined && !open) setOpenedAt(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 0 });

  function show() {
    if (open) return;
    openedWith.current = popupInput();
    setOpenedAt(revision);
  }

  function close(restoreFocus = false) {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpenedAt(undefined);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const viewport = window.visualViewport;
    if (!aboveTrigger) {
      const rect = button.getBoundingClientRect();
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16;
      const viewportBottom = topEdge + (viewport?.height ?? innerHeight) - 16;
      const bottomEdge = Math.min(viewportBottom, bottomBoundaryRef?.current?.getBoundingClientRect().bottom ?? viewportBottom);
      const below = bottomEdge - rect.bottom - 6;
      const aboveEnd = Math.min(rect.top - 6, bottomEdge);
      const above = aboveEnd - topEdge;
      const menuHeight = menu.scrollHeight + (menu.offsetHeight - menu.clientHeight);
      const upwards = menuHeight > below && above > below;
      const maxHeight = Math.max(0, upwards ? above : below);
      setPosition({
        left: Math.max(leftEdge, Math.min(align === 'start' ? rect.left : rect.right - menu.offsetWidth, rightEdge - menu.offsetWidth)),
        top: upwards ? aboveEnd - Math.min(menuHeight, maxHeight) : rect.bottom + 6,
        maxHeight,
      });
    }
    const scrollChanged = capturePopupScroll(button, viewport);
    const initialFocus = focusMode === 'panel' ? menu : menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
    // A touch-opened composer menu shares the screen with the software keyboard.
    // Taking focus from its editor would dismiss the keyboard and move the trigger.
    const editor = focusMode === 'editing' && openedWith.current === 'pointer' && document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement : null;
    if (!editor) initialFocus?.focus({ preventScroll: true });
    const editorKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
    };
    const edited = () => close();
    editor?.addEventListener('keydown', editorKey);
    editor?.addEventListener('input', edited);

    const outside = (event: Event) => {
      if (event.target instanceof Node && !button.contains(event.target) && !menu.contains(event.target)) close();
    };
    const modal = button.closest('dialog[open]');
    const dismiss = (event: Event) => {
      // A menu anchored in the composer moves with its trigger during keyboard panning.
      if (aboveTrigger && (event.type === 'resize' || event.type === 'scroll')) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;
      // Story can scroll behind a modal as streamed text arrives.
      if (modal && event.target instanceof Element && !modal.contains(event.target)) return;
      if (event.type === 'scroll' && !scrollChanged(event.target)) return;
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
      editor?.removeEventListener('keydown', editorKey);
      editor?.removeEventListener('input', edited);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('wheel', dismiss);
      window.removeEventListener('touchmove', dismiss);
      window.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('scroll', dismiss);
    };
  }, [open, label, align, aboveTrigger, bottomBoundaryRef, focusMode, trigger]);

  // A modal makes content outside its own tree inert, including body portals.
  const anchor = open ? trigger.current : null;
  const menuHost = anchor && (aboveTrigger ? anchor.parentElement : anchor.closest('dialog[open]') ?? document.body);
  return <>
    <button ref={trigger} type="button" className="quiet action-menu-trigger" disabled={disabled}
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          show();
        }
      }}><Icon name="MoreHorizontal" /></button>
    {menuHost && createPortal(<div ref={panel} id={id} role="menu" aria-label={label}
      className="action-menu floating-controls" style={aboveTrigger ? undefined : position} tabIndex={focusMode === 'panel' ? -1 : undefined}
      onClickCapture={event => {
        if ((focusMode === 'item' || popupInput() === 'keyboard')
          && event.target instanceof Element && event.target.closest('button:not(:disabled)')) {
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
          restorePopupFocusAfterEscape(trigger.current, openedWith.current);
          close();
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
