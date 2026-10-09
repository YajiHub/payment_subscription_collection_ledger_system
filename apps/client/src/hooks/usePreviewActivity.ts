// Tells the renderer whether a preview window is blocking the main window.
//
// The main process owns the window lifecycle and pushes the state over IPC. The
// renderer cannot detect the block itself: a modal preview makes the OS consume any
// click aimed at the window behind it, so no event ever reaches this page. In a
// plain browser (`vite dev`) there is no bridge and no separate preview window, so
// the state stays closed.

import { useEffect, useState } from "react";

import type { PreviewActivityState } from "../../electron/preview-activity";

/** The state before any preview has opened: nothing is blocking the window. */
export const NO_PREVIEW_OPEN: PreviewActivityState = { isOpen: false, documentName: null };

export function usePreviewActivity(): PreviewActivityState {
  const [activity, setActivity] = useState<PreviewActivityState>(NO_PREVIEW_OPEN);

  useEffect(() => {
    const bridge = window.electronAPI;

    if (bridge === undefined) {
      return;
    }

    let isCancelled = false;

    const unsubscribe = bridge.onPreviewActivityChanged((state) => {
      if (!isCancelled) {
        setActivity(state);
      }
    });

    // A preview may already be open if this subscribed after it opened, so ask for
    // the state that is current now rather than waiting for the next change.
    void bridge
      .getPreviewActivity()
      .then((state) => {
        if (!isCancelled) {
          setActivity(state);
        }
      })
      .catch(() => {
        // The main process owns the truth; a failed read must not blank the notice.
      });

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }, []);

  return activity;
}
