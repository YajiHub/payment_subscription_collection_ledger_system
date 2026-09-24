// Electron main process.
//
// Responsibilities are limited to OS-level features: creating the window,
// native file dialogs, printing, and app lifecycle. It NEVER opens a database
// connection and never queries data — the renderer talks to the Fastify API.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

// electron-vite sets ELECTRON_RENDERER_URL while the Vite dev server is running.
const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL;

/** Where an administrator edits the API server this installation talks to. */
const CLIENT_CONFIG_DIRECTORY_NAME = "BCIS";
const CLIENT_CONFIG_FILE_NAME = "config.json";
const DEFAULT_API_BASE_URL = "http://localhost:3001";

/** The path documented in docs/deployment/README.md: %APPDATA%\BCIS\config.json. */
function clientConfigFilePath(): string {
  return path.join(app.getPath("appData"), CLIENT_CONFIG_DIRECTORY_NAME, CLIENT_CONFIG_FILE_NAME);
}

/**
 * Reads `config.json`, returning its `apiBaseUrl` when it is a string.
 *
 * The file is optional: when it is missing or malformed the renderer falls back
 * to the URL compiled into the bundle. A typo in a config file must never stop
 * the office from working, so every failure returns "no value" instead of throwing.
 */
function readClientApiBaseUrl(): string | null {
  try {
    const parsedConfig: unknown = JSON.parse(fs.readFileSync(clientConfigFilePath(), "utf8"));

    if (typeof parsedConfig !== "object" || parsedConfig === null) {
      return null;
    }

    const apiBaseUrl = (parsedConfig as { apiBaseUrl?: unknown }).apiBaseUrl;
    return typeof apiBaseUrl === "string" ? apiBaseUrl : null;
  } catch {
    return null;
  }
}

/**
 * Writes a starter `config.json` on first launch, so the documented path exists
 * and an administrator only has to edit the URL rather than create the file.
 */
function ensureClientConfigFileExists(): void {
  const filePath = clientConfigFilePath();

  if (fs.existsSync(filePath)) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ apiBaseUrl: DEFAULT_API_BASE_URL }, null, 2)}\n`);
  } catch (error) {
    // Not fatal: the renderer still starts with its built-in fallback URL.
    console.warn(`Could not write ${filePath}:`, error);
  }
}

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

// The renderer asks which API server this installation should use. The main
// process only reads a JSON file; it never opens a database or an HTTP connection.
ipcMain.handle("get-app-config", () => ({
  apiBaseUrl: readClientApiBaseUrl(),
  configFilePath: clientConfigFilePath(),
}));

ipcMain.handle("open-file-picker", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("print-window", (event) => {
  // The OS print dialog handles the actual printing.
  return BrowserWindow.fromWebContents(event.sender)?.webContents.print();
});

// Report preview: a separate window that shows a report document and can be printed
// from there. The renderer supplies the finished HTML; the main process only opens a
// window for it, so no data is fetched here either.
ipcMain.handle("open-print-preview", async (_event, htmlContent: string) => {
  const previewWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Print Preview",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  await previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
});

void app.whenReady().then(() => {
  ensureClientConfigFileExists();
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
