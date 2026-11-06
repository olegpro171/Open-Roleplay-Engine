import { useLocale } from './localization';
import { Icon } from './Icon';
import type { ButtonHTMLAttributes } from 'react';

const actionIcons = {
  input: 'EditInput',
  response: 'EditResponse',
  regenerate: 'Refresh',
  cancel: 'Stop',
  pin: 'BookmarkOutline',
  unpin: 'Bookmark',
} as const;

type TurnAction = keyof typeof actionIcons;

export function TurnActionButton({ action, label, ...props }: {
  action: TurnAction; label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  useLocale();
  return <button {...props} type="button" className={`quiet turn-action turn-action-${action}`} aria-label={label} title={label}>
    <Icon name={actionIcons[action]} />
    <span className="turn-action-label">{label}</span>
  </button>;
}
