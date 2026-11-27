import { z } from 'zod';
import { backupReviewSchema, type BackupReview } from '../shared/backups';
import { localizedMessageSchema, message, type LocalizedMessage } from '../shared/localization';
import { LocalizedError } from './localization';

export class BackupUploadError extends Error {
  constructor(message: string, readonly details?: string, readonly localized?: LocalizedMessage) { super(message); }
}

const failureSchema = z.object({ message: z.string(), details: z.string().optional(), localized: localizedMessageSchema.optional() });

// Keep the upload streaming and let the server report its own work after transfer.
export function uploadBackup(file: File, password: string, progressId: string, onTransfer: (sent: number | null) => void): Promise<BackupReview> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/data/stages');
    request.responseType = 'json';
    request.setRequestHeader('X-ORE-Progress-Id', progressId);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-ORE-File-Password', btoa(String.fromCharCode(...new TextEncoder().encode(password))));
    request.upload.onprogress = event => onTransfer(event.loaded);
    request.upload.onload = () => onTransfer(null);
    request.onerror = request.onabort = () => reject(new LocalizedError(message('errors.network_request_failed')));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const review = backupReviewSchema.safeParse(request.response);
        if (review.success) { resolve(review.data); return; }
      } else {
        const failure = failureSchema.safeParse(request.response);
        if (failure.success) {
          reject(new BackupUploadError(failure.data.message, failure.data.details, failure.data.localized));
          return;
        }
      }
      reject(new LocalizedError(message('application_settings.backup_validation_failed')));
    };
    request.send(file);
  });
}
