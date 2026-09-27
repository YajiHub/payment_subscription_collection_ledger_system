import { z } from "zod";

/**
 * Wording, not rules.
 *
 * The shared schemas in `@bcis/shared` are the single statement of what the API
 * accepts, and they stay untouched. Their default messages are accurate but
 * robotic on a clerk's screen, so this map rewrites only the one message that
 * names the problem instead of describing it — a field that must not be blank —
 * and passes every other issue through with Zod's own wording.
 *
 * Pass it as the second argument to `zodResolver` so all six screens read alike.
 */
export const fieldErrorMap: z.ZodErrorMap = (issue, context) => {
  if (
    issue.code === z.ZodIssueCode.too_small &&
    issue.type === "string" &&
    issue.minimum === 1
  ) {
    return { message: "This field is required" };
  }

  return { message: context.defaultError };
};
