import { Icon } from './Icon';
import { locale, useLocale } from './localization';

export type BackupFileInfo = Pick<File, 'name' | 'size'>;

export function BackupFileSummary({ file }: { file: BackupFileInfo }) {
  useLocale();
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = file.size, index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  const size = new Intl.NumberFormat(locale(), { style: 'unit', unit: units[index], unitDisplay: index === 0 ? 'long' : 'short', maximumFractionDigits: 1 }).format(value);
  return <div className="backup-file-summary"><Icon name="FolderOutline" /><strong>{file.name}</strong><span>{size}</span></div>;
}
