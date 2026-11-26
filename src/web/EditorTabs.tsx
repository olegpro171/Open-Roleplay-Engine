import type { MessageKey } from '../shared/localization';
import { t, useLocale } from './localization';

type Tab<T> = readonly [T, MessageKey];

export function EditorTabs<T extends string>({ id, label, tabs, active, select, className }: {
  id: string; label: string; tabs: readonly Tab<T>[]; active: T; select: (tab: T) => void; className: string;
}) {
  useLocale();
  return <div className={className} role="tablist" aria-label={label}>
    {tabs.map(([tab, title], index) => <button key={tab} type="button" role="tab"
      id={`${id}-${tab}-tab`} aria-controls={`${id}-${tab}-panel`}
      aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
      onClick={() => select(tab)}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        let next: number;
        switch (event.key) {
          case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
          case 'ArrowRight': next = (index + 1) % tabs.length; break;
          case 'Home': next = 0; break;
          case 'End': next = tabs.length - 1; break;
          default: return;
        }
        event.preventDefault();
        const [nextTab] = tabs[next];
        select(nextTab);
        event.currentTarget.ownerDocument.getElementById(`${id}-${nextTab}-tab`)?.focus();
      }}>{t(title)}</button>)}
  </div>;
}
