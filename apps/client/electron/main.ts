// Electron main process.
//
// Responsibilities are limited to OS-level features: creating the window,
// native file dialogs, printing, and app lifecycle. It NEVER opens a database
// connection and never queries data — the renderer talks to the Fastify API.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";

// electron-vite sets ELECTRON_RENDERER_URL while the Vite dev server is running.
const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL;

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // revealed once the renderer is ready — avoids a white flash
    title: "BCIS Subscription Billing and Collection System",
    webPreferences: {
      nodeIntegration: false, // renderer cannot use Node APIs
      contextIsolation: true, // renderer and main are fully isolated
      sandbox: true, // renderer is sandboxed by the OS
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (rendererDevServerUrl !== undefined) {
    void mainWindow.loadURL(rendererDevServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

// Every channel below is a narrow, named capability. None of them can reach the
// database: the renderer talks to the Fastify API for data, and these handlers
// only drive OS features.
// Keep the request/response channel next to its handler so the whitelist stays obvious.
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("open-file-picker", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("print-window", (event) => {
  // The OS print dialog handles the actual printing.
  return BrowserWindow.fromWebContents(event.sender)?.webContents.print();
});

void app.whenReady().then(() => {
  createMainWindow();

  // On macOS the app stays open after the last window closes.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});