import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { resolveApiBaseUrl } from "@bcis/shared";
import { App } from "./App";
import { configureApiBaseUrl } from "./lib/api-client";
import { API_BASE_URL } from "./lib/constants";
import "./styles.css";

/**
 * Chooses the API server this installation talks to, before the first request.
 *
 * A packaged copy reads `%APPDATA%\BCIS\config.json` through the preload bridge,
 * so one office PC can be pointed at another PC's server without a rebuild. In a
 * plain browser (`vite dev`) the bridge is absent and the build-time URL is used.
 */
async function chooseApiBaseUrl(): Promise<void> {
  try {
    const appConfig = await window.electronAPI?.getAppConfig();
    configureApiBaseUrl(resolveApiBaseUrl(appConfig, API_BASE_URL));
  } catch {
    // A config read must never stop the app from starting; fall back to the
    // compiled-in URL and let the health badge report whether it answers.
    configureApiBaseUrl(API_BASE_URL);
  }
}

async function startApplication(): Promise<void> {
  await chooseApiBaseUrl();

  const rootElement = document.getElementById("root");

  if (rootElement === null) {
    throw new Error("Root element #root is missing from index.html");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void startApplication();