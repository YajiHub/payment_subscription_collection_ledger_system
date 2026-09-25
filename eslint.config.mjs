// ESLint 9 flat configuration for the whole monorepo.
//
// One config file at the root lints every workspace, so `pnpm lint` from the root
// checks the server, the client, and the shared package in a single pass.

import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/.pi/**",
      "apps/server/src/db/migrations/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },

  {
    files: ["apps/client/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // The electron-builder configuration is CommonJS (electron-builder reads it
  // with require), so it needs the CommonJS globals rather than module scope.
  {
    files: ["apps/client/electron-builder.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },

  // The Electron GUI smoke check is CommonJS on purpose: Electron loads it as a
  // main-process entry point, where `require("electron")` is the supported form.
  // It also needs browser globals: the login helper in it is serialised and
  // evaluated inside the renderer through executeJavaScript, where `document` and
  // `window` are the page's, not Node's.
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Must stay last: turns off every rule that would fight Prettier's formatting.
  prettier
);