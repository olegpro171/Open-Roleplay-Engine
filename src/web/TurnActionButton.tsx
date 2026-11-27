import { useLocale } from './localization';
import { Icon } from './Icon';
import type { ButtonHTMLAttributes } from 'react';

const actionIcons = {
  input: 'EditInput',
  response: 'EditResponse',
  regenerate: 'Refresh',
  cancel: 'Stop',
  dismiss: 'Close',
  apply: 'Check',
  pin: 'BookmarkOutline',
  unpin: 'Bookmark',
} as const;

type TurnAction = keyof typeof actionIcons;

export function TurnActionButton({ action, label, alternateLabel, ...props }: {
  action: TurnAction; label: string; alternateLabel?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  useLocale();
  return <button {...props} type="button" className={`quiet turn-action turn-action-${action}`} aria-label={label} title={label}>
    <Icon name={actionIcons[action]} />
    <span className="turn-action-label" data-alternate={alternateLabel}>{label}</span>
  </button>;
}
