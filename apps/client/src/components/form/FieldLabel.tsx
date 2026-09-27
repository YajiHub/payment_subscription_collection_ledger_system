import type { ReactNode } from "react";

import { LABEL_CLASS } from "./field-styles";

export interface FieldLabelProps {
  /** The id of the control this label names. */
  htmlFor: string;
  children: ReactNode;
}

/**
 * The visible label above a control.
 *
 * A field stays labelled after validation fails, so a clerk never has to guess
 * which box a message belongs to.
 */
export function FieldLabel({ htmlFor, children }: FieldLabelProps): ReactNode {
  return (
    <label htmlFor={htmlFor} className={LABEL_CLASS}>
      {children}
    </label>
  );
}
