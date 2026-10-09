// Always-preview receipt printing for the Electron main process.
//
// `webContents.print()` resolves successfully on a machine with no print backend
// while printing nothing at all, so an attempt to print directly could report
// success and produce no paper. Printing is therefore never attempted here: the
// window is always rendered to a PDF, written to a temporary file, and opened in
// a Chromium PDF preview window. That viewer's own toolbar is where the user
// saves the PDF or prints it — on a machine with a printer or without one.
//
// Every side effect is passed in, so the flow itself is testable without a print
// dialog, a real printer, or a real window. The main process supplies the real ones.

/** What happened once the user asked to print. */
export type PrintOutcome =
  | { status: "preview-opened"; filePath: string }
  | { status: "failed"; reason: string };

/** The still-open preview window, and the signal that it was closed. */
export interface PrintPreviewSession {
  /** Resolves when the preview window is gone, so its temp file can be deleted. */
  whenClosed: Promise<void>;
}

/** The side effects `resolvePrintOutcome` needs, supplied by the main process. */
export interface PrintOutcomeDependencies {
  /** Renders the window to PDF bytes. */
  renderPdf: () => Promise<Buffer>;
  /** Builds the temporary file path the preview will be named after. */
  temporaryPdfPath: (documentName: string) => string;
  /** Writes the rendered PDF to disk. */
  writePdf: (filePath: string, pdfBytes: Buffer) => void;
  /** Opens the preview window for the written file and reports when it closes. */
  openPreview: (filePath: string, documentName: string) => PrintPreviewSession;
  /** Deletes a temporary preview file once its window is gone. */
  deletePdf: (filePath: string) => void;
}

/**
 * Produces a printable document and shows it: render the window to PDF, write it
 * to a temporary file, and open that file in a preview window whose toolbar saves
 * or prints it. Never throws — a failure becomes a `failed` outcome carrying the
 * reason the user needs to see, and no preview window is opened.
 */
export async function resolvePrintOutcome(
  documentName: string,
  dependencies: PrintOutcomeDependencies
): Promise<PrintOutcome> {
  let previewFilePath: string | null = null;

  try {
    const pdfBytes = await dependencies.renderPdf();
    const filePath = dependencies.temporaryPdfPath(documentName);
    previewFilePath = filePath;
    dependencies.writePdf(filePath, pdfBytes);

    const preview = dependencies.openPreview(filePath, documentName);
    // Delete the temporary file once the window closes, so temp files do not
    // accumulate. `whenClosed` cannot reject in practice, but a stray rejection
    // must still not leave the file behind.
    void preview.whenClosed.then(
      () => dependencies.deletePdf(filePath),
      () => dependencies.deletePdf(filePath)
    );

    return { status: "preview-opened", filePath };
  } catch (error) {
    // If the file was written but the window could not be opened, remove it
    // rather than leaving a temporary file nobody can see.
    if (previewFilePath !== null) {
      dependencies.deletePdf(previewFilePath);
    }
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
