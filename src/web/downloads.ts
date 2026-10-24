import { preparedDownloadSchema } from '../shared/downloads';
import { LocalizedError, message } from './localization';

export function startDownload(value: unknown): void {
  const parsed = preparedDownloadSchema.safeParse(value);
  if (!parsed.success) throw new LocalizedError(message('errors.download_failed'));
  const link = document.createElement('a');
  link.href = parsed.data.url;
  link.download = parsed.data.filename;
  link.hidden = true;
  document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); }
}
