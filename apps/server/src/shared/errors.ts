// Custom error classes used across the server.
// A route handler throws one of these; the Fastify error handler in index.ts
// turns it into the matching HTTP status code and a consistent JSON body.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

/** Base class for every error this system throws deliberately. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(message: string, statusCode: number, code: ErrorCode) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The request was understood but the supplied values are not acceptable. */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

/** The caller is not authenticated (missing, invalid, or revoked credentials). */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED");
  }
}

/** The caller is authenticated but is not allowed to perform this action. */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super(message, 403, "FORBIDDEN");
  }
}

/** The requested record does not exist. */
export class NotFoundError extends AppError {
  constructor(message = "The requested record was not found") {
    super(message, 404, "NOT_FOUND");
  }
}

/** The request conflicts with the current state, e.g. a duplicate username. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

/** True when the error was thrown deliberately by our own code. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}