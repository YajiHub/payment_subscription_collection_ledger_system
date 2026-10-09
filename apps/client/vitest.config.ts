// Renderer unit tests.
//
// The renderer runs in the browser inside Electron, so tests run under jsdom
// with the same React plugin the renderer build uses. The E2E suite (Playwright,
// `e2e/`) and the electron-vite build output (`out/`) are excluded: only
// co-located `*.test.ts(x)` files next to the code they cover are collected —
// including the Electron main-process logic in `electron/`, which is plain
// dependency-injected code with no DOM or Electron import of its own.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    exclude: ["e2e/**", "out/**", "node_modules/**"],
  },
});