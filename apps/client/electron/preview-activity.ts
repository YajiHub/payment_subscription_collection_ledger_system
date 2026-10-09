// Tracks the preview windows that are open, so the main window can say why it is
// not responding.
//
// A receipt or report preview opens as a `modal` child window. That modality is
// deliberate — the document must be dealt with before the cashier carries on — but
// it means the OS consumes any click aimed at the window behind it: the renderer
// never sees the click and cannot react to it. The only honest way to explain the
// block is to push the state from the main process, which owns the window
// lifecycle, to the parent renderer BEFORE the click. This module is that state and
// the wiring that keeps it true. It imports no Electron, driving an injected window
// instead, so the counting and the lifecycle rules are unit-testable on their own.

/** What the renderer needs in order to describe why the main window is blocked. */
export interface PreviewActivityState {
  /** True while at least one preview window is open. */
  isOpen: boolean;
  /** The title of the most recently opened preview, e.g. "Official Receipt OR-2026-000001". */
  documentName: string | null;
}

/** The IPC channel the main process pushes `PreviewActivityState` on. */
export const PREVIEW_ACTIVITY_CHANNEL = "preview-activity";

export interface PreviewActivityTracker {
  /** Records a preview window opening and returns the new state. */
  opened(documentName: string): PreviewActivityState;
  /** Records a preview window closing and returns the new state. */
  closed(): PreviewActivityState;
  /** The state right now, without changing it. */
  current(): PreviewActivityState;
}

/**
 * Counts open preview windows rather than holding a single boolean: with two
 * previews open, closing the first must not tell the renderer that the window is
 * free again. The document name is the most recent one, so a second preview renames
 * the notice instead of being invisible behind the first.
 */
export function createPreviewActivityTracker(): PreviewActivityTracker {
  let openCount = 0;
  let mostRecentDocumentName: string | null = null;

  function snapshot(): PreviewActivityState {
    return openCount > 0
      ? { isOpen: true, documentName: mostRecentDocumentName }
      : { isOpen: false, documentName: null };
  }

  return {
    opened(documentName) {
      openCount += 1;
      mostRecentDocumentName = documentName;
      return snapshot();
    },
    closed() {
      // A stray extra close (a crash that also fires `closed`) must not drive the
      // count below zero and leave the notice stuck on screen.
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        mostRecentDocumentName = null;
      }
      return snapshot();
    },
    current() {
      return snapshot();
    },
  };
}

/** The parts of an Electron `BrowserWindow` this module drives. */
export interface PreviewWindowLike {
  focus(): void;
  flashFrame(flag: boolean): void;
  isDestroyed(): boolean;
  once(event: "focus", listener: () => void): void;
  once(event: "closed", listener: () => void): void;
  webContents: { once(event: "render-process-gone", listener: () => void): void };
}

/**
 * Registers a preview window for the whole of its life: it counts as open as soon
 * as it exists, it takes the focus and flashes for attention, and it is cleared on
 * every route out — the close button, the window manager, `destroy()`, or a renderer
 * crash — so the window behind it is never left looking blocked with nothing on
 * screen to explain why. `onStateChanged` is called with the new state on open and
 * again on close, and is the only way the renderer hears about it.
 */
export function trackPreviewWindow(
  previewWindow: PreviewWindowLike,
  tracker: PreviewActivityTracker,
  documentName: string,
  onStateChanged: (state: PreviewActivityState) => void
): void {
  onStateChanged(tracker.opened(documentName));

  // The preview owns the interaction until it is closed, so it must be the window in
  // front and say so. The flash stops the moment it holds the focus, rather than
  // flashing forever on a machine where it already has it.
  previewWindow.focus();
  previewWindow.flashFrame(true);
  previewWindow.once("focus", () => {
    if (!previewWindow.isDestroyed()) {
      previewWindow.flashFrame(false);
    }
  });

  let hasReportedClosed = false;
  const reportClosed = (): void => {
    // `closed` fires for a normal close and for `destroy()`; a crashed renderer can
    // fire both, so a window is only ever counted out once.
    if (hasReportedClosed) {
      return;
    }
    hasReportedClosed = true;
    onStateChanged(tracker.closed());
  };

  previewWindow.once("closed", reportClosed);
  previewWindow.webContents.once("render-process-gone", reportClosed);
}
