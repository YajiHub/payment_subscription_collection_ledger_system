// One place that turns a Zod result into a thrown ValidationError.
//
// Every handler validates its input the same way, so a bad request always becomes
// the same 400 envelope with the first human-readable problem in the message.

import type { z } from "zod";

import { ValidationError } from "./errors";

/** Parses `data` with `schema`, or throws a ValidationError carrying the first problem. */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  data: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? "Invalid request");
  }
  return result.data;
}
