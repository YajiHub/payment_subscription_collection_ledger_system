// Preload script — the ONLY bridge between the sandboxed renderer and Electron main.
//
// Whitelist rule: if a capability is not listed here, React cannot call it.
// Because the renderer is sandboxed it has no `require`, no `fs`, no `net`.

import { contextBridge, ipcRenderer } from "electron";

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

  /** Version of the installed desktop application, shown in the UI footer. */
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke("get-app-version");
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronApi);

export type ElectronApi = typeof electronApi;