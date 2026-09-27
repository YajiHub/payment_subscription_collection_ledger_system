import { zodResolver } from "@hookform/resolvers/zod";
import type { FieldValues, Resolver } from "react-hook-form";
import type { z } from "zod";

import { fieldErrorMap } from "./field-error-map";

/**
 * The resolver every form in the renderer uses.
 *
 * It is `@hookform/resolvers`' `zodResolver` with one addition: Zod's default
 * wording is replaced by `fieldErrorMap`, so a blank required field reads as
 * "This field is required" instead of "String must contain at least 1 character(s)".
 * The rules themselves are untouched — they stay in the schema that is passed in,
 * which for most of these screens is the same schema the server validates with.
 *
 * The second argument is Zod's own `ParseParams`. Its type demands a `path` and an
 * `async` flag that a resolver never reads, so they are given the values Zod would
 * use while parsing asynchronously.
 */
export function formResolver<Input extends FieldValues, Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>
): Resolver<Input, unknown, Output> {
  return zodResolver(schema, { errorMap: fieldErrorMap, path: [], async: true });
}
