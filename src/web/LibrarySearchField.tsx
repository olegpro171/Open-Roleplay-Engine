import { Icon } from './Icon';

export function LibrarySearchField({ label, value, change }: {
  label: string;
  value: string;
  change: (value: string) => void;
}) {
  return <div className="library-search">
    <Icon name="Search" />
    <input type="search" aria-label={label} placeholder={label} value={value} onChange={event => change(event.target.value)} />
  </div>;
}
