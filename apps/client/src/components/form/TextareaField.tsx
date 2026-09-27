import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from "react";

import { FieldError } from "./FieldError";
import { FieldHint } from "./FieldHint";
import { FieldLabel } from "./FieldLabel";
import { DISABLED_CONTROL_CLASS, INVALID_CONTROL_CLASS, TEXTAREA_CLASS, describedBy } from "./field-styles";
import type { FieldChromeProps } from "./TextField";

export type TextareaFieldProps = FieldChromeProps &
  Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "id" | "aria-invalid" | "aria-describedby" | "className"
  > & {
    className?: string;
  };

/**
 * A labelled multi-line text field wired for inline validation.
 *
 * Spread React Hook Form's `register("fieldName")` result onto it: it supplies
 * `name`, `onChange`, `onBlur` and the `ref` this component forwards.
 */
export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  function TextareaField(
    { id, label, error, hint, containerClassName = "", className = "", ...textareaProps },
    ref
  ): ReactNode {
    const errorId = `${id}-error`;
    const hintId = `${id}-hint`;

    return (
      <div className={`space-y-1.5 ${containerClassName}`}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <textarea
          {...textareaProps}
          id={id}
          ref={ref}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(
            error === undefined ? undefined : errorId,
            hint === undefined ? undefined : hintId
          )}
          className={`${TEXTAREA_CLASS} ${DISABLED_CONTROL_CLASS} ${
            error === undefined ? "" : INVALID_CONTROL_CLASS
          } ${className}`}
        />
        {hint !== undefined && <FieldHint id={hintId}>{hint}</FieldHint>}
        {error !== undefined && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    );
  }
);
