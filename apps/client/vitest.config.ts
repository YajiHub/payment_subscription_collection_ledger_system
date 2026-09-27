// Renderer unit tests.
//
// The renderer runs in the browser inside Electron, so tests run under jsdom
// with the same React plugin the renderer build uses. The E2E suite (Playwright,
// `e2e/`) and the electron-vite build output (`out/`) are excluded: only
// co-located `*.test.ts(x)` files next to the code they cover are collected.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "out/**", "node_modules/**"],
  },
});