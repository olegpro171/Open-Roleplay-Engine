import { useRef, type ComponentPropsWithRef, type MouseEvent } from 'react';

type Props = Omit<ComponentPropsWithRef<'dialog'>, 'onCancel' | 'onClick' | 'onPointerDown' | 'onPointerCancel'> & {
  onDismiss: () => void;
  dismissOnEmptySpace?: boolean;
};

function isBackdrop(event: MouseEvent<HTMLDialogElement>, dismissOnEmptySpace: boolean) {
  // Native dialogs receive backdrop events on the dialog itself, as they do for padding.
  if (event.target !== event.currentTarget) return false;
  if (dismissOnEmptySpace) return true;
  const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

export function ModalDialog({ onDismiss, dismissOnEmptySpace = false, ...props }: Props) {
  const pressedBackdrop = useRef(false);
  return <dialog {...props}
    onCancel={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }}
    onPointerDown={event => {
      if (event.isPrimary) pressedBackdrop.current = event.button === 0 && isBackdrop(event, dismissOnEmptySpace);
    }}
    onPointerCancel={event => {
      if (event.isPrimary) pressedBackdrop.current = false;
    }}
    onClick={event => {
      // A drag that starts inside can also produce a click targeted at the dialog.
      const dismiss = pressedBackdrop.current && event.detail > 0 && isBackdrop(event, dismissOnEmptySpace);
      pressedBackdrop.current = false;
      if (dismiss) {
        event.stopPropagation();
        onDismiss();
      }
    }}
  />;
}
