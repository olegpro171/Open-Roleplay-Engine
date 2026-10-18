import type { ButtonHTMLAttributes } from 'react';

type TurnAction = 'delete' | 'input' | 'response' | 'regenerate' | 'cancel' | 'reasoning';

const icons: Record<TurnAction, string> = {
  delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  input: 'M12 20H4V4h11M10 14l1-4 7-7 3 3-7 7-4 1Z',
  response: 'M8 18H4V4h16v9M8 18l-4 3v-3M13 21l1-4 5-5 3 3-5 5-4 1Z',
  regenerate: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
  cancel: 'M6 6h12v12H6z',
  reasoning: 'M9 18h6M10 21h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z',
};

export function TurnActionButton({ action, label, onFocus, ...props }: {
  action: TurnAction; label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return <button {...props} type="button" className={`quiet turn-action turn-action-${action}`} aria-label={label} title={label}
    onFocus={event => {
      // Native focus may leave a partly visible action clipped in the phone row.
      event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      onFocus?.(event);
    }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icons[action]} /></svg>
    <span className="turn-action-label">{label}</span>
  </button>;
}
