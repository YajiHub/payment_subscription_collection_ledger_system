// Electron main process.
//
// Responsibilities are limited to OS-level features: creating the window,
// native file dialogs, printing, and app lifecycle. It NEVER opens a database
// connection and never queries data — the renderer talks to the Fastify API.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { resolvePrintOutcome, type PrintOutcome, type PrintPreviewSession } from "./printing";
import {
  createPreviewActivityTracker,
  PREVIEW_ACTIVITY_CHANNEL,
  trackPreviewWindow,
  type PreviewActivityState,
} from "./preview-activity";

// Prevent GPU process crashes and fullscreen/resize hangs in WSLg / Linux
app.disableHardwareAcceleration();

// electron-vite sets ELECTRON_RENDERER_URL while the Vite dev server is running.
const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL;

/** Where an administrator edits the API server this installation talks to. */
const CLIENT_CONFIG_DIRECTORY_NAME = "BCIS";
const CLIENT_CONFIG_FILE_NAME = "config.json";
const DEFAULT_API_BASE_URL = "http://localhost:3003";

/** The path documented in docs/deployment/README.md: %APPDATA%\BCIS\config.json. */
function clientConfigFilePath(): string {
  return path.join(app.getPath("appData"), CLIENT_CONFIG_DIRECTORY_NAME, CLIENT_CONFIG_FILE_NAME);
}

/**
 * The preview windows that are open right now.
 *
 * This lives in the main process because only it sees the window lifecycle. A modal
 * preview blocks the window behind it at the OS level, so the renderer cannot
 * detect the block — it can only be told.
 */
const previewActivity = createPreviewActivityTracker();

/** Pushes the current preview state to the window a preview is blocking. */
function broadcastPreviewActivity(
  parentWindow: BrowserWindow | null,
  state: PreviewActivityState
): void {
  // The main window can be gone (the app is quitting) while a preview is still
  // closing; there is then nobody to tell and nothing to throw at.
  if (parentWindow === null || parentWindow.isDestroyed()) {
    return;
  }

  parentWindow.webContents.send(PREVIEW_ACTIVITY_CHANNEL, state);
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
    x: 100,
    y: 100,
    minWidth: 1024,
    minHeight: 700,
    center: true,
    show: true, // Show immediately so Windows/WSLg renders the window on screen
    // Clicking the fullscreen control under Linux/WSLg hangs the GPU compositor and
    // the window stops repainting. Windows fullscreen works normally, so only Linux
    // loses the control; maximize through the window manager there instead.
    fullscreenable: process.platform !== "linux",
    title: "BCIS Subscription Billing and Collection System",
    webPreferences: {
      nodeIntegration: false, // renderer cannot use Node APIs
      contextIsolation: true, // renderer and main are fully isolated
      sandbox: true, // renderer is sandboxed by the OS
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  mainWindow.center();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();

  mainWindow.once("ready-to-show", () => {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  // A hung renderer previously left the app frozen with no way back: the window
  // stayed on screen and the only recovery was killing the process from a
  // terminal. Reload the renderer instead, so the app recovers by itself.
  mainWindow.on("unresponsive", () => {
    console.error("Renderer became unresponsive; reloading it.");
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
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

// Printing always previews. The window is rendered to a PDF, written to a temp
// file named after the document, and opened in a viewer window whose toolbar
// saves the PDF or prints it. `print()` is never called: it resolves successfully
// on a machine with no print backend while printing nothing, so its result cannot
// be trusted. The outcome tells the renderer whether the preview opened.
ipcMain.handle("print-window", async (event): Promise<PrintOutcome> => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  if (senderWindow === null) {
    return { status: "failed", reason: "The window to preview is no longer open." };
  }

  const senderContents = senderWindow.webContents;
  const documentName = senderWindow.getTitle();

  return resolvePrintOutcome(documentName, {
    renderPdf: () => senderContents.printToPDF({}),
    temporaryPdfPath: (name) =>
      path.join(app.getPath("temp"), `${safePreviewFileName(name)}-${Date.now()}.pdf`),
    writePdf: (filePath, pdfBytes) => {
      fs.writeFileSync(filePath, pdfBytes);
    },
    openPreview: (filePath, name) => openPdfPreviewWindow(senderWindow, filePath, name),
    deletePdf: (filePath) => {
      fs.rmSync(filePath, { force: true });
    },
  });
});

// Report preview: a separate window that shows a report document and can be printed
// from there. The renderer supplies the finished HTML; the main process only opens a
// window for it, so no data is fetched here either.
ipcMain.handle("open-print-preview", async (event, htmlContent: string) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const previewWindow = new BrowserWindow({
    ...(senderWindow === null ? {} : { parent: senderWindow, modal: true }),
    width: 900,
    height: 700,
    title: "Print Preview",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  registerPreviewWindow(previewWindow, senderWindow, previewWindow.getTitle());

  await previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
});

// The renderer asks for the current state when it mounts, so a notice is correct
// even if it subscribed after a preview had already opened.
ipcMain.handle("get-preview-activity", (): PreviewActivityState => previewActivity.current());

/** Turns a window title into a file name the OS will accept. */
function safePreviewFileName(documentName: string): string {
  const cleaned = documentName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned === "" ? "document" : cleaned).slice(0, 80);
}

/**
 * Opens a rendered PDF in a Chromium PDF viewer window, made a child of the
 * sender so it cannot be lost behind the app. That viewer's own toolbar is where
 * the user saves the PDF or prints it — with a printer attached or without one.
 * The returned session resolves when the window is closed, so the temporary file
 * can be deleted.
 */
function openPdfPreviewWindow(
  senderWindow: BrowserWindow,
  filePath: string,
  documentName: string
): PrintPreviewSession {
  const previewWindow = new BrowserWindow({
    parent: senderWindow,
    // Modal so the receipt must be dealt with — saved, printed or dismissed — before
    // the cashier can carry on in the main window. Without this the preview sits on
    // top while clicks still reach the page behind it, which loses work.
    modal: true,
    width: 900,
    height: 1000,
    title: documentName,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  previewWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Preview failed to load (${errorCode}): ${errorDescription}`);
  });

  registerPreviewWindow(previewWindow, senderWindow, documentName);

  void previewWindow.loadFile(filePath);

  return {
    whenClosed: new Promise<void>((resolve) => {
      previewWindow.once("closed", () => resolve());
    }),
  };
}

/**
 * Registers a preview window with the shared tracker and relays each state change to
 * the window the preview is blocking. The lifecycle rules live in `preview-activity`
 * so they can be tested without a real window.
 */
function registerPreviewWindow(
  previewWindow: BrowserWindow,
  parentWindow: BrowserWindow | null,
  documentName: string
): void {
  trackPreviewWindow(previewWindow, previewActivity, documentName, (state) => {
    broadcastPreviewActivity(parentWindow, state);
  });
}

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
