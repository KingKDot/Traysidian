# Close to Tray

Keeps Obsidian running in the system tray when you close its window, instead of quitting. Useful for the Obsidian command line interface, which needs the app running.

Desktop only.

## Usage

- **Close a vault window** (title bar ×, Alt+F4): the window and its pop-outs hide to the tray. The vault stays loaded, so plugins, sync, and CLI commands keep working.
- **Click the tray icon** to bring hidden windows back.
- **Right-click the tray icon** for *Show Obsidian*, *Hide Obsidian*, and *Quit Obsidian*.
- **Command palette**: *Hide this vault to the tray* and *Quit Obsidian*.
- **Launching Obsidian again** (Start menu, shortcut, `obsidian://` link) brings hidden windows back. CLI commands do not.

To exit Obsidian completely, use *Quit Obsidian*.

With several vaults open, there is still only one tray icon, and its menu acts on all windows. Close-to-tray applies only to vaults with the plugin enabled.

## How it works

The plugin runs entirely inside Obsidian and makes no network requests. It uses the Electron APIs Obsidian already exposes to plugins (`require('electron').remote`):

- A capturing `beforeunload` listener cancels the window close and hides the window instead. Reloads are left alone. Quitting the app is left alone too, so Obsidian's own shutdown and save logic still runs.
- A main-process `close` listener stops Obsidian from force-destroying the window 3 seconds after a cancelled close.
- The tray icon is created in Obsidian's main process from Obsidian's own `icon.png`.

Window-close handling relies on Obsidian internals (the `is-closing`/`is-quitting` IPC channels and the window-close timer). It was verified against Obsidian 1.14.4 on Windows. macOS and Linux use the same code paths but have not been tested.

### macOS

- The menu bar icon is a monochrome template image (Obsidian's icon shape), so it follows light and dark menu bars.
- Clicking the menu bar icon opens its menu; clicking the Dock icon brings hidden windows back.
- Closing a window with the red button hides it. Cmd+Q quits as usual.

## Installing manually

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/KingKDot/Traysidian/releases).
2. Put them in `<vault>/.obsidian/plugins/close-to-tray/`.
3. Reload Obsidian and enable **Close to Tray** under *Settings → Community plugins*.

## Development

```sh
npm install
npm run dev     # rebuild main.js on change
npm run build   # type-check + production build
npm run lint
```

For live testing, symlink or copy `main.js`, `manifest.json`, and `styles.css` into a test vault's `.obsidian/plugins/close-to-tray/`.

### Releasing

1. Update `minAppVersion` in `manifest.json` if needed, then run `npm version <patch|minor|major>`. This bumps `manifest.json`, `package.json`, and `versions.json`.
2. `git push --follow-tags`. The release workflow builds the plugin and creates a draft GitHub release with `main.js`, `manifest.json`, and `styles.css` attached.
3. Publish the draft.

## License

[Apache-2.0](LICENSE)
