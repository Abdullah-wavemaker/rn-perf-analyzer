/** Errors that are safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new AppError(400, code, message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
