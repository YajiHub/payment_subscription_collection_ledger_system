// Playwright configuration for the Electron end-to-end suite (S10-1).
//
// The suite drives the real built application — the Electron main process, the
// real login form, the real screens — so the renderer is exercised the way an
// operator uses it. It needs no downloaded browser: `_electron.launch` runs the
// Electron binary the client already depends on.
//
// Prerequisites (documented in docs/testing/README.md):
//   * the API running against the demo dataset, on the port the renderer expects
//   * the renderer served for the HTTP origin the API allows (python3 -m http.server)
//
// Run with:  pnpm test:e2e     (from the repository root)

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // One Electron app and one shared demo database: parallel workers would race on
  // the same subscriber rows.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
});
