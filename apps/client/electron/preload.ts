// Preload script — the ONLY bridge between the sandboxed renderer and Electron main.
//
// Whitelist rule: if a capability is not listed here, React cannot call it.
// Because the renderer is sandboxed it has no `require`, no `fs`, no `net`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { PREVIEW_ACTIVITY_CHANNEL, type PreviewActivityState } from "./preview-activity";
import type { PrintOutcome } from "./printing";

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

  /**
   * Asks the main process to show the print preview for the current window.
   * Resolves with what actually happened: the preview opened, or it failed with
   * the reason. No printer is required — the preview window saves or prints.
   */
  printCurrentWindow: (): Promise<PrintOutcome> => {
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

  /**
   * The preview windows that are open right now. The window behind a modal preview
   * is blocked at the OS level, so the renderer cannot detect that itself — it can
   * only be told, and this is where the notice gets its state.
   */
  getPreviewActivity: (): Promise<PreviewActivityState> => {
    return ipcRenderer.invoke("get-preview-activity");
  },

  /**
   * Calls `listener` whenever a preview window opens or closes. Returns a function
   * that removes the listener, so a component can stop listening when it unmounts.
   */
  onPreviewActivityChanged: (
    listener: (state: PreviewActivityState) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: PreviewActivityState): void => {
      listener(state);
    };
    ipcRenderer.on(PREVIEW_ACTIVITY_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(PREVIEW_ACTIVITY_CHANNEL, handler);
    };
  },

  /**
   * The API server this installation talks to, read from %APPDATA%\BCIS\config.json,
   * plus the path of that file so the UI can tell a user where to change it.
   */
  getAppConfig: (): Promise<{ apiBaseUrl: string | null; configFilePath: string }> => {
    return ipcRenderer.invoke("get-app-config");
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronApi);

export type ElectronApi = typeof electronApi;
