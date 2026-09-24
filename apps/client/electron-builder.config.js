// electron-builder configuration for the Windows installer (NSIS).
//
// Kept as a config file rather than a package.json key so the paths stay readable.
// electron-vite compiles the renderer, main, and preload bundles into `out/` (see
// electron.vite.config.ts); those three bundles plus package.json are everything
// the desktop app needs, because Vite bundles every renderer dependency into
// `out/renderer`. The API server is deliberately NOT bundled: it runs as its own
// process on PC-1 and the client reaches it over the LAN.
//
// Build with:  pnpm --filter client package:win   (from the repository root)
//
// The build produces a Windows .exe, so it must run on Windows: electron-builder
// cross-compiling an NSIS installer from Linux/macOS needs Wine, which is not
// part of this project's toolchain.

module.exports = {
  appId: "com.bcis.subscription-billing",
  productName: "BCIS Subscription Billing System",
  copyright: `Copyright © ${new Date().getFullYear()} BCIS`,

  directories: {
    output: "installer",
    buildResources: "build-resources",
  },

  files: ["out/**/*", "package.json"],

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },

  nsis: {
    oneClick: false, // show the installation wizard
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "BCIS Billing",
    // installerIcon / uninstallerIcon / license are set once a real icon and
    // licence text exist; electron-builder uses its defaults until then. See
    // build-resources/README.md.
  },

  // The API server is not bundled. Ship the environment template so an installer
  // can see what the server expects, and the client config template so the URL of
  // PC-1 can be set without a rebuild.
  extraResources: [
    { from: "../../.env.example", to: "config.example.env" },
    { from: "config.example.json", to: "config.example.json" },
  ],
};