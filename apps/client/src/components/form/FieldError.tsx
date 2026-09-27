import type { ReactNode } from "react";

import { ERROR_CLASS } from "./field-styles";

export interface FieldErrorProps {
  /** The id the invalid control points at with `aria-describedby`. */
  id: string;
  children: ReactNode;
}

/**
 * The message that belongs to one field.
 *
 * It sits directly under the control it names and carries the id the control
 * describes itself with, so a screen reader reads the reason on focus. It is also
 * a live region, so the message is announced the moment a submit produces it.
 */
export function FieldError({ id, children }: FieldErrorProps): ReactNode {
  return (
    <p id={id} role="alert" className={ERROR_CLASS}>
      {children}
    </p>
  );
}
