// The banner wording for each print outcome.
//
// Printing always opens a PDF preview window (see electron/printing.ts), so every
// page that offers a print action shares this mapping: the preview is open and
// where to save or print from, or why it could not be opened instead of the
// failure disappearing.

import { describe, expect, it } from "vitest";

import { describePrintOutcome } from "./print-outcome";

describe("describePrintOutcome", () => {
  it("says the preview is open and points at the toolbar", () => {
    const report = describePrintOutcome({
      status: "preview-opened",
      filePath: "/tmp/OR-2026-000001.pdf",
    });

    expect(report.tone).toBe("success");
    expect(report.message).toContain("preview");
    expect(report.message).toContain("toolbar");
  });

  it("shows the reason when the preview could not be opened", () => {
    const report = describePrintOutcome({
      status: "failed",
      reason: "EACCES: permission denied",
    });

    expect(report.tone).toBe("error");
    expect(report.message).toContain("EACCES: permission denied");
  });

  it("names the toolbar's download button and print button for the user", () => {
    const report = describePrintOutcome({
      status: "preview-opened",
      filePath: "/tmp/OR-2026-000001.pdf",
    });

    expect(report.message).toContain("download");
    expect(report.message).toContain("print");
  });

  it("reads a failure as a preview problem rather than a successful open", () => {
    const report = describePrintOutcome({ status: "failed", reason: "no display available" });

    expect(report.tone).toBe("error");
    expect(report.message).toMatch(/open the preview/i);
    expect(report.message).not.toContain("Preview opened");
  });
});
