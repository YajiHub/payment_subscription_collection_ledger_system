import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";

import { FieldError } from "./FieldError";
import { FieldHint } from "./FieldHint";
import { FieldLabel } from "./FieldLabel";
import { CONTROL_CLASS, DISABLED_CONTROL_CLASS, INVALID_CONTROL_CLASS, describedBy } from "./field-styles";
import type { FieldChromeProps } from "./TextField";

export type SelectFieldProps = FieldChromeProps &
  Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "id" | "aria-invalid" | "aria-describedby" | "className" | "children"
  > & {
    className?: string;
    /** The `<option>` list. */
    children: ReactNode;
  };

/**
 * A labelled select wired for inline validation.
 *
 * Spread React Hook Form's `register("fieldName")` result onto it, and pass the
 * option list as children.
 */
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { id, label, error, hint, containerClassName = "", className = "", children, ...selectProps },
  ref
): ReactNode {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        {...selectProps}
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
      >
        {children}
      </select>
      {hint !== undefined && <FieldHint id={hintId}>{hint}</FieldHint>}
      {error !== undefined && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
});
