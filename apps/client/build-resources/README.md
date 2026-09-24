# Build resources

Files electron-builder looks for in this folder when packaging the Windows app.

The build works without any of them; electron-builder falls back to its default
Electron icon. Add them before a real release:

| File        | Purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| `icon.ico`  | Application and installer icon (Windows `.ico`, 256×256 or up)  |
| `LICENSE.txt` | Licence text shown by the NSIS installer wizard               |

When `icon.ico` and `LICENSE.txt` exist, re-enable them in
`electron-builder.config.js` under `win.icon`, `nsis.installerIcon`,
`nsis.uninstallerIcon`, and `nsis.license`.