export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

// Details must be authored diagnostics, never raw database/provider error messages.
export class BackupValidationError extends AppError {
  constructor(public readonly details: string) {
    super(422, 'invalid_backup', 'This file is not a valid ORE backup.');
  }
}
