import { useLocale } from './localization';
import { Icon } from './Icon';
import type { ButtonHTMLAttributes } from 'react';

type TurnAction = 'input' | 'response' | 'regenerate' | 'cancel' | 'pin' | 'unpin';

const editIcons = {
  input: 'M12 20H4V4h11M10 14l1-4 7-7 3 3-7 7-4 1Z',
  response: 'M8 18H4V4h16v9M8 18l-4 3v-3M13 21l1-4 5-5 3 3-5 5-4 1Z',
};

export function TurnActionButton({ action, label, ...props }: {
  action: TurnAction; label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  useLocale();
  return <button {...props} type="button" className={`quiet turn-action turn-action-${action}`} aria-label={label} title={label}>
    {action === 'pin' || action === 'unpin' ? <Icon name={action === 'pin' ? 'BookmarkOutline' : 'Bookmark'} />
      : action === 'regenerate' || action === 'cancel' ? <Icon name={action === 'regenerate' ? 'Refresh' : 'Stop'} />
      : <svg viewBox="0 0 24 24" aria-hidden="true"><path d={editIcons[action]} /></svg>}
    <span className="turn-action-label">{label}</span>
  </button>;
}
