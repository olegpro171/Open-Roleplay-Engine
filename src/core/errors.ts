import { message, type LocalizedMessage } from '../shared/localization.js';

export class AppError extends Error {
  readonly localized?: LocalizedMessage;
  constructor(public readonly status: number, public readonly code: string, message: string | LocalizedMessage) {
    super(typeof message === 'string' ? message : message.fallback);
    if (typeof message !== 'string') this.localized = message;
  }
}

// Details must be authored diagnostics, never raw database/provider error messages.
export class BackupValidationError extends AppError {
  constructor(public readonly details: string) {
    super(422, 'invalid_backup', message('errors.invalidBackup'));
  }
}
