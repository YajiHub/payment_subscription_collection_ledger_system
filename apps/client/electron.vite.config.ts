// electron-vite configuration.
//
// The React renderer lives in `src/` (with its index.html) and the Electron
// main/preload processes live in `electron/`, matching the folder layout in
// specs/phase1-foundation.md §3.

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";
import path from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: {
        entry: path.resolve(__dirname, "electron/main.ts"),
      },
      rollupOptions: {
        output: { entryFileNames: "index.js" },
      },
    },
  },

  preload: {
    build: {
      outDir: "out/preload",
      lib: {
        entry: path.resolve(__dirname, "electron/preload.ts"),
      },
      rollupOptions: {
        // The renderer is sandboxed, so the preload bundle must be CommonJS.
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },

  renderer: {
    root: path.resolve(__dirname, "src"),
    build: {
      outDir: path.resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: path.resolve(__dirname, "src/index.html"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});