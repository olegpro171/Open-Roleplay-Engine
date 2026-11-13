import { useLayoutEffect, useRef } from 'react';
import { useConfirmation } from './Confirmation';
import { message as msg } from './localization';

export type LeaveEditor = (action: () => void, options?: { returnFocus?: HTMLElement; deferDiscard?: true }) => void;

export function useConfirmEditorLeave(scope: string | null, isDirty: () => boolean, discard?: () => void): LeaveEditor {
  const confirm = useConfirmation(scope);
  return (action, { returnFocus, deferDiscard } = {}) => {
    if (!isDirty()) { action(); return; }
    confirm({
      title: msg('library_draft.leave_title'), message: msg('library_draft.leave_message'),
      cancelLabel: msg('library_draft.go_back'), actionLabel: msg('library_draft.leave_editor'),
      returnFocus,
      onConfirm: () => {
        if (!deferDiscard) discard?.();
        action();
      },
    });
  };
}

export function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = true;
}

export function useEditorLeaveGuard(scope: string | null) {
  const dirty = useRef(false);
  const leave = useConfirmEditorLeave(scope, () => dirty.current);
  return { dirty, leave };
}

export function useWarnOnEditorLeave(guard: ReturnType<typeof useEditorLeaveGuard>, dirty: boolean) {
  const flag = guard.dirty;
  useLayoutEffect(() => {
    if (!dirty) return;
    flag.current = true;
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      flag.current = false;
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, [flag, dirty]);
}
