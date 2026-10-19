import { remote } from 'electron';
import type { BrowserWindow, ElectronEvent, NativeImage, Tray } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';

/**
 * Every vault window runs its own copy of this plugin, but the app should show a single
 * tray icon. The icon and the id of the window that owns it live on the main-process
 * `app` object under this key, where every vault window can see them.
 */
const STATE_KEY = 'closeToTray';
/** Set on main-process `BrowserWindow`s that this plugin hid, so "Show" restores exactly those. */
const HIDDEN_KEY = 'closeToTrayHidden';
/** Lets the remaining vault windows take over the icon when its owner unloads the plugin. */
const CHANNEL_NAME = 'close-to-tray';

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

/**
 * Obsidian's logomark from its brand kit (https://obsidian.md/brand), in a 25-unit-tall
 * viewBox. Each path is a facet; the gaps between them carry the icon's detail.
 */
const LOGOMARK_PATHS = [
	'M7 14.6a12 12 0 0 1 2.8-.6 10 10 0 0 1 .5-8.8l.4-.7a32.9 32.9 0 0 0 .9-2.3v-1c-.1-.4-.3-.7-.7-1.1-.6-.2-1.1 0-1.6.3L4.2 5.1c-.3.2-.5.6-.6 1l-.4 3a14.6 14.6 0 0 1 3.7 5.5Zm-4-4.2-.1.3-2.8 6c-.2.7-.1 1.4.4 1.9L4.8 23a8.7 8.7 0 0 0 .8-8.7c-.7-1.8-1.9-3.2-2.6-4Z',
	'M5.8 23.5H6a23.8 23.8 0 0 1 7.4 1.4c1.2.4 2.3-.5 2.5-1.7a7 7 0 0 1 .8-2.7c-.8-2-1.6-3.2-2.6-4a5 5 0 0 0-2.9-1.3c-1.6-.2-3 .2-4 .5.6 2.3.4 5-1.4 7.8Z',
	'm17.4 19.3 2-3c0-.4 0-.7-.2-1a18 18 0 0 1-2-3.5c-.7-1.4-.7-3.5-.8-4.6 0-.4 0-.7-.3-1l-3.4-4.3v.6L12 4l-.5 1-.3.6A11 11 0 0 0 10 9.4c0 1.3 0 2.8.9 4.7h.4c1.1.2 2.3.6 3.5 1.6 1 .8 1.8 2 2.5 3.6Z',
];
const LOGOMARK_WIDTH = 19.6;
const LOGOMARK_HEIGHT = 25;

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
	const canvas = createEl('canvas', { attr: { width: size, height: size } });
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Close to Tray: 2D canvas unavailable');
	return { canvas, context };
}

/**
 * Writes the macOS menu bar icon and returns its path.
 *
 * Menu bar icons are template images: black plus alpha, which the system tints for light
 * and dark menu bars. A silhouette of the colour app icon loses its facets, so this draws
 * the logomark instead, which keeps them as transparent gaps.
 *
 * `@electron/remote` copies NativeImages between processes as bare bitmaps and drops the
 * template flag, so a template image built here would reach the main process as plain
 * black pixels. Electron marks images loaded from a `…Template.png` path as templates
 * (picking up the `@2x` sibling too), so the icon goes through files instead.
 */
function writeMacTemplateIcon(): string {
	const templateDir = join(tmpdir(), 'obsidian-close-to-tray');
	mkdirSync(templateDir, { recursive: true });
	// Menu bar icons are 18pt; the 2x copy keeps them sharp on Retina displays.
	for (const scaleFactor of [1, 2]) {
		const size = 18 * scaleFactor;
		const { canvas, context } = createCanvas(size);
		const scale = size / LOGOMARK_HEIGHT;
		context.setTransform(scale, 0, 0, scale, (size - LOGOMARK_WIDTH * scale) / 2, 0);
		context.fillStyle = '#000';
		for (const path of LOGOMARK_PATHS) context.fill(new Path2D(path));
		const dataURL = canvas.toDataURL('image/png');
		const png = Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64');
		const fileName = scaleFactor === 1 ? 'trayIconTemplate.png' : 'trayIconTemplate@2x.png';
		writeFileSync(join(templateDir, fileName), png);
	}
	return join(templateDir, 'trayIconTemplate.png');
}

/** Returns the tray image: on macOS the path to a template PNG, elsewhere the colour app icon. */
async function loadTrayIcon(): Promise<NativeImage | string> {
	if (process.platform === 'darwin') return writeMacTemplateIcon();
	const source = new Image();
	// Obsidian serves its app package at the page origin; icon.png is its window icon.
	source.src = '/icon.png';
	try {
		await source.decode();
	} catch (error) {
		console.warn('Close to Tray: could not load icon.png, using the app icon', error);
		return remote.app.getFileIcon(process.execPath, { size: 'small' });
	}
	const icon = remote.nativeImage.createEmpty();
	// Tray icons are 16px at 100% scaling; the 2x copy keeps them sharp on HiDPI.
	for (const scaleFactor of [1, 2]) {
		const size = 16 * scaleFactor;
		const { canvas, context } = createCanvas(size);
		context.imageSmoothingQuality = 'high';
		context.drawImage(source, 0, 0, size, size);
		icon.addRepresentation({ scaleFactor, dataURL: canvas.toDataURL('image/png') });
	}
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

	private createTray(icon: NativeImage | string): Tray {
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
