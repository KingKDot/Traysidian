import { Plugin } from 'obsidian';
import { ipcRenderer, remote } from 'electron';
import type { BrowserWindow, ElectronEvent } from 'electron';
import { TrayHost, hideWindows, mainReflect } from './tray-host';

export default class TraysidianPlugin extends Plugin {
	private readonly win = remote.getCurrentWindow();

	onload(): void {
		const trayHost = new TrayHost(this.win.webContents.id);
		this.register(() => trayHost.dispose());
		void trayHost.claim();

		// Capture phase so this runs before Obsidian's own `window.onbeforeunload` quit hook,
		// which would otherwise start shutting the vault down.
		this.registerDomEvent(window, 'beforeunload', this.onBeforeUnload, { capture: true });

		this.win.on('close', this.onWindowClose);
		this.register(() => this.win.removeListener('close', this.onWindowClose));

		this.addCommand({
			id: 'hide-to-tray',
			name: 'Hide this vault to the tray',
			callback: () => this.hideVaultWindows(),
		});
		this.addCommand({
			id: 'quit',
			name: 'Quit Obsidian',
			callback: () => remote.app.quit(),
		});
	}

	private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
		// Obsidian's main process answers these synchronously; its own quit hook uses them.
		// `is-closing` is true for window closes and app quits, false for reloads.
		if (ipcRenderer.sendSync('is-closing') !== true || ipcRenderer.sendSync('is-quitting') === true) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		// Obsidian flags the window as closing in its main-process 'close' handler. The close
		// is cancelled, so clear the flag; otherwise the next reload would look like a close.
		mainReflect.set(this.win, 'closing', false);
		this.hideVaultWindows();
	};

	/**
	 * Obsidian's main process destroys a closing window 3 seconds after 'close' unless the
	 * event was default-prevented. Remote listeners run asynchronously, so this cannot
	 * cancel the close itself (onBeforeUnload does that), but it does disarm that timer.
	 */
	private readonly onWindowClose = (event: ElectronEvent): void => {
		if (ipcRenderer.sendSync('is-quitting') !== true) event.preventDefault();
	};

	/** The vault's pop-out windows, then its main window. */
	private hideVaultWindows(): void {
		const popouts = new Set<Window>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.getContainer().win;
			if (win !== window) popouts.add(win);
		});
		const windows: BrowserWindow[] = [];
		for (const popout of popouts) {
			// Obsidian attaches the matching BrowserWindow to each pop-out's global object. That
			// proxy belongs to another remote-module realm, so passing it back to the main process
			// would send a copy; look the window up again through this realm's remote module.
			const id = (popout as Window & { electronWindow?: { id: number } }).electronWindow?.id;
			const electronWindow = id === undefined ? null : remote.BrowserWindow.fromId(id);
			if (electronWindow) windows.push(electronWindow);
		}
		// Main window last: hiding it also hides pop-outs it owns, and a pop-out that is
		// already hidden would not be marked for restoring.
		windows.push(this.win);
		hideWindows(windows);
	}
}
