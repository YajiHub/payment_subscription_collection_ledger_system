// Explains why the main window stops responding while a preview window is open.
//
// A receipt or report preview is a `modal` child window, so the OS consumes any
// click aimed at the window behind it: the renderer never receives the click and
// cannot react to it. This notice therefore appears BEFORE the click, for as long as
// a preview is open, and it is purely informational — a control placed in the main
// window could not be clicked while the preview is modal anyway, so it has none.
// It reuses the Modal backdrop convention and the app's own tokens, and it never
// takes focus.

import type { ReactNode } from "react";
import { MonitorUp } from "lucide-react";

import { usePreviewActivity } from "../../hooks/usePreviewActivity";
import { Card } from "../ui/Card";

export function PreviewActivityNotice(): ReactNode {
  const { isOpen, documentName } = usePreviewActivity();

  if (!isOpen) {
    return null;
  }

  const document = documentName ?? "A preview window";

  return (
    <div
      // Dims the application behind it the way the Modal backdrop does, using the
      // same token (`bg-content-primary/40`), and disappears on paper.
      className="fixed inset-0 z-50 flex items-center justify-center bg-content-primary/40 p-4 print:hidden"
    >
      <Card className="w-full max-w-md">
        <div role="status" aria-live="polite" className="flex items-start gap-3 p-6">
          <MonitorUp className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 className="text-base font-medium text-content-primary">Preview window is open</h2>
            <p className="text-sm text-content-secondary">
              {document} is open in a separate window. Close it to continue working.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
