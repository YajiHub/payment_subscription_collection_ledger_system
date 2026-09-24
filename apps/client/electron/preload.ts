// Preload script — the ONLY bridge between the sandboxed renderer and Electron main.
//
// Whitelist rule: if a capability is not listed here, React cannot call it.
// Because the renderer is sandboxed it has no `require`, no `fs`, no `net`.

import { contextBridge, ipcRenderer } from "electron";

// Options accepted by the native open-file dialog. The renderer may choose a
// title and file filters; it can never ask for a directory or a raw path.
export interface OpenFilePickerOptions {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

const electronApi = {
  /** Opens the native file dialog and resolves the chosen path, or null if cancelled. */
  openFilePicker: (options: OpenFilePickerOptions = {}): Promise<string | null> => {
    return ipcRenderer.invoke("open-file-picker", options);
  },

  /** Asks the main process to print the current window using OS print services. */
  printCurrentWindow: (): Promise<void> => {
    return ipcRenderer.invoke("print-window");
  },

  /**
   * Opens a separate Electron window showing a finished report document, so it can
   * be reviewed and printed from there. The renderer passes the HTML it already
   * rendered; the main process fetches nothing.
   */
  openPrintPreview: (htmlContent: string): Promise<void> => {
    return ipcRenderer.invoke("open-print-preview", htmlContent);
  },

  /** Version of the installed desktop application, shown in the UI footer. */
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke("get-app-version");
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronApi);

export type ElectronApi = typeof electronApi;
