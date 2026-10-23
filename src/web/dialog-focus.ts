/** Open a modal on its heading, leaving all controls idle until user interaction. */
export function openModal(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  const heading = dialog.querySelector('h2');
  if (heading) {
    // Native showModal otherwise focuses the first control, even without React
    // autoFocus, which can also open a phone's keyboard on password/search fields.
    heading.tabIndex = -1;
    heading.autofocus = true;
  }
  dialog.showModal();
  if (!heading) dialog.focus({ preventScroll: true });
}
