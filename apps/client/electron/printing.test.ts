// The always-preview print flow, which has to work on a machine with no printer.
//
// `webContents.print()` resolves successfully while printing nothing when there is
// no print backend, so printing directly could report success and produce no paper.
// These tests pin the rule that replaced it: always render the window to a PDF,
// write it, and open it in a preview window whose toolbar saves or prints it.

import { describe, expect, it, vi } from "vitest";

import {
  resolvePrintOutcome,
  type PrintOutcomeDependencies,
  type PrintPreviewSession,
} from "./printing";

/** A preview session whose closure the test controls. */
function buildPreviewSession(): PrintPreviewSession & { close: () => void } {
  let close = (): void => undefined;
  const whenClosed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return { whenClosed, close };
}

/** Dependencies with sane defaults, so each test states only what it is about. */
function buildDependencies(
  overrides: Partial<PrintOutcomeDependencies> = {}
): PrintOutcomeDependencies {
  return {
    renderPdf: () => Promise.resolve(Buffer.from("%PDF-1.4 receipt")),
    temporaryPdfPath: () => "/tmp/Receipt-OR-2026-000001.pdf",
    writePdf: () => undefined,
    openPreview: () => buildPreviewSession(),
    deletePdf: () => undefined,
    ...overrides,
  };
}

describe("resolvePrintOutcome", () => {
  it("renders a PDF and opens a preview window for the written file", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 receipt");
    const renderPdf = vi.fn(() => Promise.resolve(pdfBytes));
    const writePdf = vi.fn();
    const openPreview = vi.fn(() => buildPreviewSession());

    await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({ renderPdf, writePdf, openPreview })
    );

    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(writePdf).toHaveBeenCalledWith("/tmp/Receipt-OR-2026-000001.pdf", pdfBytes);
    expect(openPreview).toHaveBeenCalledWith(
      "/tmp/Receipt-OR-2026-000001.pdf",
      "Official Receipt OR-2026-000001"
    );
  });

  it("names the written PDF file and reports the preview as opened", async () => {
    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({ temporaryPdfPath: () => "/tmp/OR-2026-000001.pdf" })
    );

    expect(outcome).toEqual({ status: "preview-opened", filePath: "/tmp/OR-2026-000001.pdf" });
  });

  it("reports the reason and opens no preview when the PDF cannot be rendered", async () => {
    const openPreview = vi.fn(() => buildPreviewSession());

    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        renderPdf: () => Promise.reject(new Error("Printing failed: page is blank")),
        openPreview,
      })
    );

    expect(outcome).toEqual({ status: "failed", reason: "Printing failed: page is blank" });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("reports the reason and opens no preview when the PDF cannot be written", async () => {
    const openPreview = vi.fn(() => buildPreviewSession());

    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        writePdf: () => {
          throw new Error("EACCES: permission denied");
        },
        openPreview,
      })
    );

    expect(outcome).toEqual({ status: "failed", reason: "EACCES: permission denied" });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("deletes the temporary file once the preview window is closed", async () => {
    const preview = buildPreviewSession();
    const deletePdf = vi.fn();

    await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        temporaryPdfPath: () => "/tmp/OR-2026-000001.pdf",
        openPreview: () => preview,
        deletePdf,
      })
    );

    // While the preview is open the file must stay on disk for the viewer to read.
    expect(deletePdf).not.toHaveBeenCalled();

    preview.close();

    await vi.waitFor(() => {
      expect(deletePdf).toHaveBeenCalledWith("/tmp/OR-2026-000001.pdf");
    });
  });

  it("reports the preview as opened without waiting for the window to close", async () => {
    const preview = buildPreviewSession();
    const deletePdf = vi.fn();

    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({ openPreview: () => preview, deletePdf })
    );

    // The window is still open, so the file must not have been cleaned up yet.
    expect(outcome.status).toBe("preview-opened");
    expect(deletePdf).not.toHaveBeenCalled();
  });

  it("passes the document name on to the temporary file path builder", async () => {
    const temporaryPdfPath = vi.fn(() => "/tmp/x.pdf");

    await resolvePrintOutcome(
      "Official Receipt OR-2026-000009",
      buildDependencies({ temporaryPdfPath })
    );

    expect(temporaryPdfPath).toHaveBeenCalledWith("Official Receipt OR-2026-000009");
  });

  it("reports the reason and opens no preview when the temporary path cannot be built", async () => {
    const openPreview = vi.fn(() => buildPreviewSession());

    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        temporaryPdfPath: () => {
          throw new Error("no temporary directory");
        },
        openPreview,
      })
    );

    expect(outcome).toEqual({ status: "failed", reason: "no temporary directory" });
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("removes the file it wrote when the preview window cannot be opened", async () => {
    const deletePdf = vi.fn();

    const outcome = await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        temporaryPdfPath: () => "/tmp/OR-2026-000001.pdf",
        openPreview: () => {
          throw new Error("no display available");
        },
        deletePdf,
      })
    );

    expect(outcome).toEqual({ status: "failed", reason: "no display available" });
    expect(deletePdf).toHaveBeenCalledWith("/tmp/OR-2026-000001.pdf");
  });

  it("still removes the temporary file when the window's close signal rejects", async () => {
    const deletePdf = vi.fn();

    await resolvePrintOutcome(
      "Official Receipt OR-2026-000001",
      buildDependencies({
        temporaryPdfPath: () => "/tmp/OR-2026-000001.pdf",
        openPreview: () => ({ whenClosed: Promise.reject(new Error("window crashed")) }),
        deletePdf,
      })
    );

    await vi.waitFor(() => {
      expect(deletePdf).toHaveBeenCalledWith("/tmp/OR-2026-000001.pdf");
    });
  });
});
