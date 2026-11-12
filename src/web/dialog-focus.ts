import { flushSync } from 'react-dom';
import { popupInput } from './popup-input';

type OpenDialog = { input: 'keyboard' } | {
  input: 'pointer';
  dismissing: boolean;
  parent: HTMLDialogElement | null;
};
const openDialogs = new Map<HTMLDialogElement, OpenDialog>();

/** Open a modal on its heading and return the cleanup for its layout effect. */
export function openModal(dialog: HTMLDialogElement | null, returnFocus?: Element | null) {
  if (!dialog) return;
  const opener = returnFocus ?? document.activeElement;
  const state: OpenDialog = popupInput() === 'pointer'
    ? { input: 'pointer', dismissing: false, parent: Array.from(openDialogs.keys()).at(-1) ?? null }
    : { input: 'keyboard' };
  const heading = dialog.querySelector('h2');
  if (heading) {
    // Native showModal otherwise focuses the first control, even without React
    // autoFocus, which can also open a phone's keyboard on password/search fields.
    heading.tabIndex = -1;
    heading.autofocus = true;
  }
  dialog.showModal();
  openDialogs.set(dialog, state);
  if (!heading) dialog.focus({ preventScroll: true });
  return () => {
    openDialogs.delete(dialog);
    // Closing an attached native dialog restores its previous focus. On
    // pointer-opened Escape dismissal, let React remove it from the top layer first.
    if (state.input === 'pointer' && state.dismissing) return;
    dialog.close();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  };
}

export function dismissModalWithEscape(dialog: HTMLDialogElement | null, dismiss: () => void) {
  const state = dialog && openDialogs.get(dialog);
  if (!dialog || state?.input !== 'pointer') {
    dismiss();
    return;
  }
  // Keep the dismissal reason through unmount, then clear it even if a guard
  // keeps the dialog open. A later button click uses normal focus restoration.
  state.dismissing = true;
  try {
    flushSync(dismiss);
  } finally {
    state.dismissing = false;
  }
  if (dialog.isConnected) return;
  // Removal already clears the top layer. Safari can restore the opener
  // even if close() is called on the detached dialog.
  const parent = state.parent;
  if (parent?.isConnected && parent.open && document.activeElement === document.body) {
    (parent.querySelector('h2') ?? parent).focus({ preventScroll: true });
  }
}
