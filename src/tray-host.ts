import { remote } from 'electron';
import type { BrowserWindow, ElectronEvent, NativeImage, Tray } from 'electron';
import { existsSync } from 'fs';
import { basename, resolve } from 'path';

/**
 * Every vault window runs its own copy of this plugin, but the app should show a single
 * tray icon. The icon and the id of the window that owns it live on the main-process
 * `app` object under this key, where every vault window can see them.
 */
const STATE_KEY = 'traysidian';
/** Set on main-process `BrowserWindow`s that this plugin hid, so "Show" restores exactly those. */
const HIDDEN_KEY = 'traysidianHidden';
/** Lets the remaining vault windows take over the icon when its owner unloads the plugin. */
const CHANNEL_NAME = 'traysidian';

/**
 * Main-process `Reflect`. Calling it through the remote module runs the operation in the
 * main process, where the remote proxies we pass in resolve to the real objects.
 */
export const mainReflect = remote.getGlobal('Reflect');

export function hideWindows(windows: readonly BrowserWindow[]): void {
	for (const win of windows) {
		if (win.isDestroyed() || !win.isVisible()) continue;
		mainReflect.set(win, HIDDEN_KEY, true);
		win.hide();
	}
}

function showAllWindows(): void {
	for (const win of remote.BrowserWindow.getAllWindows()) {
		if (win.isDestroyed()) continue;
		if (mainReflect.get(win, HIDDEN_KEY) === true) {
			mainReflect.deleteProperty(win, HIDDEN_KEY);
			win.show();
		}
		// Never focus a window we did not show: Obsidian keeps some helper windows hidden.
		if (!win.isVisible()) continue;
		if (win.isMinimized()) win.restore();
		win.focus();
	}
}

function isWebContentsAlive(id: number): boolean {
	const contents = remote.webContents.fromId(id);
	return contents !== undefined && !contents.isDestroyed();
}

function destroyTray(tray: unknown): void {
	const candidate = tray as Tray | undefined;
	if (candidate && !candidate.isDestroyed()) candidate.destroy();
}

/**
 * Claims the shared tray slot for `ownerId`. Returns the main-process state object on
 * success, or null if another live vault window already owns the tray.
 */
function acquireOwnership(ownerId: number): object | null {
	let state = mainReflect.get(remote.app, STATE_KEY) as object | undefined;
	if (state !== undefined) {
		const owner = mainReflect.get(state, 'owner') as number | undefined;
		if (owner !== undefined && owner !== ownerId && isWebContentsAlive(owner)) return null;
		if (owner !== undefined) {
			// The owner window is gone, or this window reloaded without unloading the plugin.
			destroyTray(mainReflect.get(state, 'tray'));
			state = undefined;
		}
	}
	if (state === undefined) {
		mainReflect.set(remote.app, STATE_KEY, {});
		state = mainReflect.get(remote.app, STATE_KEY) as object;
	}
	// `owner` is defined non-configurable and non-writable, so when several windows race
	// for the slot, the main process accepts exactly one definition.
	if (!mainReflect.defineProperty(state, 'owner', { value: ownerId, enumerable: true })) return null;
	return state;
}

async function loadTrayIcon(): Promise<NativeImage> {
	const isMac = process.platform === 'darwin';
	const source = new Image();
	// Obsidian serves its app package at the page origin; icon.png is its window icon.
	source.src = '/icon.png';
	try {
		await source.decode();
	} catch (error) {
		console.warn('Traysidian: could not load icon.png, using the app icon', error);
		// On macOS the executable's own icon is generic; the .app bundle carries the real one.
		const iconPath = isMac ? resolve(process.execPath, '../../..') : process.execPath;
		return remote.app.getFileIcon(iconPath, { size: 'small' });
	}
	const icon = remote.nativeImage.createEmpty();
	// Tray icons are 16px at 100% scaling (menu bar icons 18pt on macOS); the 2x copy keeps
	// them sharp on HiDPI.
	const baseSize = isMac ? 18 : 16;
	for (const scaleFactor of [1, 2]) {
		const size = baseSize * scaleFactor;
		const canvas = createEl('canvas', { attr: { width: size, height: size } });
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Traysidian: 2D canvas unavailable');
		context.imageSmoothingQuality = 'high';
		context.drawImage(source, 0, 0, size, size);
		if (isMac) {
			// macOS menu bar icons are template images: black plus alpha, which the system
			// tints for light/dark menu bars. Keep the icon's shape, paint it black.
			context.globalCompositeOperation = 'source-in';
			context.fillStyle = '#000';
			context.fillRect(0, 0, size, size);
		}
		icon.addRepresentation({ scaleFactor, dataURL: canvas.toDataURL('image/png') });
	}
	if (isMac) icon.setTemplateImage(true);
	return icon;
}

/**
 * Whether a second launch of Obsidian is the user opening the app (no arguments, an
 * `obsidian://` link, or a file) rather than a CLI command. Mirrors how Obsidian's main
 * process interprets forwarded arguments.
 */
function isUserLaunch(argv: readonly string[], workingDirectory: string): boolean {
	const args = argv.slice(1).filter((arg) => !arg.startsWith('--'));
	if (basename(argv[0] ?? '').toLowerCase().includes('electron')) args.shift();
	// Windows CLI invocations are tagged with the pipe they want the answer on.
	const isCli = args[0]?.startsWith('session=') ?? false;
	const target = args.at(-1);
	if (target === undefined) return !isCli;
	return target.startsWith('obsidian://') || existsSync(resolve(workingDirectory, target));
}

function onSecondInstance(_event: ElectronEvent, argv: string[], workingDirectory: string): void {
	// CLI commands must not bring windows forward: running headless is the point of this plugin.
	if (isUserLaunch(argv, workingDirectory)) showAllWindows();
}

export class TrayHost {
	private readonly channel = new BroadcastChannel(CHANNEL_NAME);
	private tray: Tray | null = null;
	private claiming = false;
	private disposed = false;

	constructor(private readonly ownerId: number) {
		this.channel.onmessage = () => void this.claim();
	}

	/** Creates the tray icon unless another vault window already owns it. */
	async claim(): Promise<void> {
		if (this.disposed || this.tray || this.claiming) return;
		this.claiming = true;
		try {
			const icon = await loadTrayIcon();
			if (this.disposed) return;
			const state = acquireOwnership(this.ownerId);
			if (!state) return;
			this.tray = this.createTray(icon);
			mainReflect.set(state, 'tray', this.tray);
			remote.app.on('second-instance', onSecondInstance);
			// macOS: clicking the dock icon.
			remote.app.on('activate', showAllWindows);
		} finally {
			this.claiming = false;
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.tray) {
			remote.app.removeListener('second-instance', onSecondInstance);
			remote.app.removeListener('activate', showAllWindows);
			destroyTray(this.tray);
			this.tray = null;
			const state = mainReflect.get(remote.app, STATE_KEY) as object | undefined;
			if (state !== undefined && mainReflect.get(state, 'owner') === this.ownerId) {
				mainReflect.deleteProperty(remote.app, STATE_KEY);
			}
			// Without the icon, hidden windows would be unreachable, so bring them back. Another
			// vault window running the plugin takes the icon over on 'released'.
			showAllWindows();
			this.channel.postMessage('released');
		}
		this.channel.close();
	}

	private createTray(icon: NativeImage): Tray {
		const tray = new remote.Tray(icon);
		tray.setToolTip('Obsidian');
		tray.setContextMenu(
			remote.Menu.buildFromTemplate([
				{ label: 'Show Obsidian', click: showAllWindows },
				{ label: 'Hide Obsidian', click: () => hideWindows(remote.BrowserWindow.getAllWindows()) },
				{ type: 'separator' },
				{ label: 'Quit Obsidian', click: () => remote.app.quit() },
			]),
		);
		tray.on('click', showAllWindows);
		return tray;
	}
}
