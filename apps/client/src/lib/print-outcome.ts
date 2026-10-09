// Plain-language description of a print outcome, for an on-screen banner.
//
// Printing always opens a PDF preview window (see electron/printing.ts): the
// window is rendered to a PDF that the viewer's toolbar can save or print. So
// there are only two things to tell the user — the preview is open, or it could
// not be opened and why. Pages share this mapping so none of them silently
// swallow a failure.

import type { PrintOutcome } from "../../electron/printing";

export interface PrintOutcomeReport {
  /** Which banner the page should use to show the message. */
  tone: "success" | "error";
  message: string;
}

/**
 * Describes what happened in the words a cashier needs: the preview window is
 * open and where to save or print from, or why it could not be opened.
 */
export function describePrintOutcome(outcome: PrintOutcome): PrintOutcomeReport {
  switch (outcome.status) {
    case "preview-opened":
      return {
        tone: "success",
        message:
          "Preview opened. In the preview window's toolbar, the download button saves a PDF and the print button prints it.",
      };
    case "failed":
      return { tone: "error", message: `Could not open the preview: ${outcome.reason}` };
  }
}
