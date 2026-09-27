import type { ReactNode } from "react";

import { HINT_CLASS } from "./field-styles";

export interface FieldHintProps {
  /** The id the control points at with `aria-describedby`. */
  id: string;
  children: ReactNode;
}

/** The quiet explanatory line under a control, e.g. "At least 8 characters." */
export function FieldHint({ id, children }: FieldHintProps): ReactNode {
  return (
    <p id={id} className={HINT_CLASS}>
      {children}
    </p>
  );
}
