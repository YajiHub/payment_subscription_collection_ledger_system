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

declare global {
  interface Window {
    electronAPI?: {
      /** Open the native file dialog and resolve the chosen path, or null. */
      openFilePicker: (options?: {
        title?: string;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<string | null>;
      /** Ask the main process to print the current window. */
      printCurrentWindow: () => Promise<void>;
      /** Open a separate window showing a finished report document. */
      openPrintPreview: (htmlContent: string) => Promise<void>;
      /** Version of the installed desktop application. */
      getAppVersion: () => Promise<string>;
    };
  }
}
