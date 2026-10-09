// The "why has the window stopped responding?" notice.
//
// A modal preview swallows clicks aimed at the window behind it, so the renderer
// can only be TOLD that a preview is open. These tests pin the three things that
// matter: nothing shows by default (the app must not look permanently blocked), the
// notice appears and names the document while a preview is open, and it clears when
// the preview closes.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PreviewActivityState } from "../../../electron/preview-activity";
import { PreviewActivityNotice } from "./PreviewActivityNotice";

type PreviewActivityListener = (state: PreviewActivityState) => void;

/**
 * Installs a fake preload bridge whose pushed states the test controls. Returns the
 * function that pushes a state, the way the main process would.
 */
function installPreviewBridge(
  current: PreviewActivityState = { isOpen: false, documentName: null }
): (state: PreviewActivityState) => void {
  const listeners = new Set<PreviewActivityListener>();

  window.electronAPI = {
    getPreviewActivity: () => Promise.resolve(current),
    onPreviewActivityChanged: (listener: PreviewActivityListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as NonNullable<Window["electronAPI"]>;

  return (state) => {
    for (const listener of listeners) {
      listener(state);
    }
  };
}

afterEach(() => {
  delete window.electronAPI;
});

describe("PreviewActivityNotice", () => {
  it("shows nothing when no preview is open", () => {
    render(<PreviewActivityNotice />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows nothing when the bridge reports no preview open", async () => {
    installPreviewBridge();

    render(<PreviewActivityNotice />);

    // Let the mount-time "what is open now?" read settle.
    await act(async () => {});

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names the open document and what to do, then clears when the preview closes", async () => {
    const pushState = installPreviewBridge();

    render(<PreviewActivityNotice />);
    await act(async () => {});

    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      pushState({ isOpen: true, documentName: "Official Receipt OR-2026-000001" });
    });

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Official Receipt OR-2026-000001");
    expect(notice).toHaveTextContent("is open in a separate window");
    expect(notice).toHaveTextContent("Close it to continue working");

    act(() => {
      pushState({ isOpen: false, documentName: null });
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the notice when a preview was already open when it mounted", async () => {
    installPreviewBridge({ isOpen: true, documentName: "Print Preview" });

    render(<PreviewActivityNotice />);

    expect(await screen.findByRole("status")).toHaveTextContent("Print Preview");
  });

  it("stays informational: no control to click and it takes no focus", async () => {
    const pushState = installPreviewBridge();

    render(<PreviewActivityNotice />);
    await act(async () => {});

    act(() => {
      pushState({ isOpen: true, documentName: "Official Receipt OR-2026-000001" });
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });
});
