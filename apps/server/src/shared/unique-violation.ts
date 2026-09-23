// Recognises PostgreSQL errors we want to translate into a clean HTTP response
// instead of a 500.
//
// A unique-constraint violation (SQLSTATE 23505) almost always means the caller
// raced another request or repeated a value that must be unique. The routes catch
// it and rethrow a ConflictError so the client sees a 409 with a readable message.

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

/** True when the error is a PostgreSQL unique-constraint violation. */
export function isUniqueViolation(error: unknown): error is PostgresErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as PostgresErrorLike).code === "23505"
  );
}
