import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { FieldError } from "./FieldError";
import { FieldHint } from "./FieldHint";
import { FieldLabel } from "./FieldLabel";
import { CONTROL_CLASS, DISABLED_CONTROL_CLASS, INVALID_CONTROL_CLASS, describedBy } from "./field-styles";

/** What every field in the set needs, whatever the control underneath it is. */
export interface FieldChromeProps {
  /** Identifies the control. The label's `for`, the hint's id and the error's id derive from it. */
  id: string;
  /** The visible label, kept exactly as the screen wrote it before. */
  label: string;
  /** The message from React Hook Form. When set, the control is marked invalid. */
  error?: string | undefined;
  /** An explanatory line under the control, e.g. "At least 8 characters." */
  hint?: ReactNode;
  /** Class for the wrapper, so a caller can place the field inside a grid. */
  containerClassName?: string;
}

export type TextFieldProps = FieldChromeProps &
  Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "aria-invalid" | "aria-describedby" | "className"
  > & {
    className?: string;
  };

/**
 * A labelled text input wired for inline validation.
 *
 * Spread React Hook Form's `register("fieldName")` result onto it: it supplies
 * `name`, `onChange`, `onBlur` and the `ref` this component forwards.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, error, hint, containerClassName = "", className = "", ...inputProps },
  ref
): ReactNode {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        {...inputProps}
        id={id}
        ref={ref}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(
          error === undefined ? undefined : errorId,
          hint === undefined ? undefined : hintId
        )}
        className={`${CONTROL_CLASS} ${DISABLED_CONTROL_CLASS} ${
          error === undefined ? "" : INVALID_CONTROL_CLASS
        } ${className}`}
      />
      {hint !== undefined && <FieldHint id={hintId}>{hint}</FieldHint>}
      {error !== undefined && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});
