// Renders a Drizzle SQL node as text, for tests that must prove WHICH conditions a
// query was built with.
//
// The in-memory database records the argument of every `.where()` call, but a query
// builder is opaque to the test. Writing the condition out as text — the column
// names and the bound values — is what lets a filter test assert that a supplied
// filter really reached the SQL instead of being accepted and ignored (S6-2).
//
// It walks the same `queryChunks` structure Drizzle uses to build a statement, so it
// needs no database and no dialect.

/** One SQL node as readable text, e.g. `(assigned_collector_id = 1111-…)`. */
export function sqlDebugText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((chunk) => sqlDebugText(chunk, depth)).join("");
  }
  if (depth > 20) {
    return "";
  }

  const candidate = value as { queryChunks?: unknown[]; value?: unknown; name?: string };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.map((chunk) => sqlDebugText(chunk, depth + 1)).join("");
  }
  if (typeof candidate.name === "string") {
    return candidate.name;
  }
  if (candidate.value !== undefined) {
    return String(candidate.value);
  }
  return "";
}

/** Every recorded `.where()` argument, written out and joined. */
export function whereTextOf(conditions: readonly unknown[]): string {
  return conditions.map((condition) => sqlDebugText(condition)).join("\n");
}
