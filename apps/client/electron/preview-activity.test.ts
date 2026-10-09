// The open-preview count behind the "why is the window stuck?" notice.
//
// A modal preview swallows clicks aimed at the window behind it, so the renderer
// can only be told that a preview is open. These tests pin the counting rule that
// decides what it is told: any preview open means open, closing one of two does not
// free the window, and the state always returns to closed.

import { describe, expect, it, vi } from "vitest";

import {
  createPreviewActivityTracker,
  trackPreviewWindow,
  type PreviewActivityState,
  type PreviewWindowLike,
} from "./preview-activity";

describe("createPreviewActivityTracker", () => {
  it("starts closed, with no document name", () => {
    expect(createPreviewActivityTracker().current()).toEqual({
      isOpen: false,
      documentName: null,
    });
  });

  it("is open and names the document once a preview opens", () => {
    const tracker = createPreviewActivityTracker();

    expect(tracker.opened("Official Receipt OR-2026-000001")).toEqual({
      isOpen: true,
      documentName: "Official Receipt OR-2026-000001",
    });
  });

  it("stays open while a second preview is still open, naming the newest", () => {
    const tracker = createPreviewActivityTracker();

    tracker.opened("Official Receipt OR-2026-000001");
    expect(tracker.opened("Official Receipt OR-2026-000002")).toEqual({
      isOpen: true,
      documentName: "Official Receipt OR-2026-000002",
    });

    // Closing the first of two must not tell the renderer the window is free.
    expect(tracker.closed()).toEqual({
      isOpen: true,
      documentName: "Official Receipt OR-2026-000002",
    });
  });

  it("clears the name and returns to closed when the last preview closes", () => {
    const tracker = createPreviewActivityTracker();
    tracker.opened("Official Receipt OR-2026-000001");

    expect(tracker.closed()).toEqual({ isOpen: false, documentName: null });
  });

  it("stays closed on an extra close, so the notice cannot get stuck", () => {
    const tracker = createPreviewActivityTracker();

    expect(tracker.closed()).toEqual({ isOpen: false, documentName: null });
    expect(tracker.closed()).toEqual({ isOpen: false, documentName: null });
  });

  it("reports the state without changing it", () => {
    const tracker = createPreviewActivityTracker();
    tracker.opened("Print Preview");

    expect(tracker.current()).toEqual({ isOpen: true, documentName: "Print Preview" });
    expect(tracker.current()).toEqual(tracker.current());
  });
});

/**
 * A fake preview window that lets a test fire the lifecycle events Electron would,
 * so the wiring can be checked without a display or a real window.
 */
function buildPreviewWindow(isDestroyed = false): PreviewWindowLike & {
  emitFocus: () => void;
  emitClosed: () => void;
  emitCrashed: () => void;
  flashFrame: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  let onFocus = (): void => undefined;
  let onClosed = (): void => undefined;
  let onCrashed = (): void => undefined;
  const focus = vi.fn();
  const flashFrame = vi.fn();

  return {
    focus,
    flashFrame,
    isDestroyed: () => isDestroyed,
    once(event, listener) {
      if (event === "focus") {
        onFocus = listener;
      } else {
        onClosed = listener;
      }
    },
    webContents: {
      once(_event, listener) {
        onCrashed = listener;
      },
    },
    emitFocus: () => onFocus(),
    emitClosed: () => onClosed(),
    emitCrashed: () => onCrashed(),
  };
}

describe("trackPreviewWindow", () => {
  it("reports the window open, focuses it, and flashes it for attention", () => {
    const previewWindow = buildPreviewWindow();
    const states: PreviewActivityState[] = [];

    trackPreviewWindow(previewWindow, createPreviewActivityTracker(), "Print Preview", (state) => {
      states.push(state);
    });

    expect(states).toEqual([{ isOpen: true, documentName: "Print Preview" }]);
    expect(previewWindow.focus).toHaveBeenCalledTimes(1);
    expect(previewWindow.flashFrame).toHaveBeenCalledWith(true);
  });

  it("stops the flash once the preview holds the focus", () => {
    const previewWindow = buildPreviewWindow();

    trackPreviewWindow(
      previewWindow,
      createPreviewActivityTracker(),
      "Print Preview",
      () => undefined
    );

    previewWindow.emitFocus();

    expect(previewWindow.flashFrame).toHaveBeenCalledWith(false);
  });

  it("reports the window closed when it is closed", () => {
    const previewWindow = buildPreviewWindow();
    const states: PreviewActivityState[] = [];

    trackPreviewWindow(previewWindow, createPreviewActivityTracker(), "Print Preview", (state) => {
      states.push(state);
    });

    previewWindow.emitClosed();

    expect(states.at(-1)).toEqual({ isOpen: false, documentName: null });
  });

  it("reports the window closed only once when a crash also closes it", () => {
    const previewWindow = buildPreviewWindow();
    const states: PreviewActivityState[] = [];

    trackPreviewWindow(previewWindow, createPreviewActivityTracker(), "Print Preview", (state) => {
      states.push(state);
    });

    previewWindow.emitCrashed();
    previewWindow.emitClosed();

    // One open report and one close report — a double close would leak into the count.
    expect(states).toEqual([
      { isOpen: true, documentName: "Print Preview" },
      { isOpen: false, documentName: null },
    ]);
  });
});
