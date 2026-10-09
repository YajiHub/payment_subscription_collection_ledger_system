// Types for the Electron preload bridge.
//
// The preload script exposes a small whitelist of OS-level capabilities on
// `window.electronAPI`; the renderer may use only those. This declaration keeps
// TypeScript honest about that whitelist.
//
// `electronAPI` is optional: the renderer also runs in a plain browser during
// `vite dev`, where the bridge is absent, so callers must guard for it.
//
// Keep this list in step with the object exposed in electron/preload.ts: a capability
// that is not listed here is one the renderer may not call.

export {};

import type { PrintOutcome } from "../../electron/printing";
import type { PreviewActivityState } from "../../electron/preview-activity";

declare global {
  interface Window {
    electronAPI?: {
      /** Open the native file dialog and resolve the chosen path, or null. */
      openFilePicker: (options?: {
        title?: string;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<string | null>;
      /**
       * Ask the main process to show the print preview for the current window.
       * Resolves with the real outcome: the preview opened, or it failed with the
       * reason. Printing is never attempted directly — the preview window's toolbar
       * saves the PDF or prints it, with or without a printer.
       */
      printCurrentWindow: () => Promise<PrintOutcome>;
      /** Open a separate window showing a finished report document. */
      openPrintPreview: (htmlContent: string) => Promise<void>;
      /** Version of the installed desktop application. */
      getAppVersion: () => Promise<string>;
      /** The preview windows that are open right now; the main process owns this state. */
      getPreviewActivity: () => Promise<PreviewActivityState>;
      /** Calls the listener when a preview opens or closes; returns an unsubscribe function. */
      onPreviewActivityChanged: (listener: (state: PreviewActivityState) => void) => () => void;
      /** The configured API server and the file that holds that setting. */
      getAppConfig: () => Promise<{ apiBaseUrl: string | null; configFilePath: string }>;
    };
  }
}
