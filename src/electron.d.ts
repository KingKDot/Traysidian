// Minimal typings for the parts of Electron this plugin touches. Obsidian exposes
// `@electron/remote` as `require('electron').remote`, so every object below is a
// proxy for an object that lives in Obsidian's main process.
//
// Declared locally instead of depending on the `electron` package, which would pull
// a full Electron binary into `npm install` just for types.

declare module 'electron' {
	interface ElectronEvent {
		preventDefault(): void;
	}

	interface NativeImage {
		addRepresentation(options: { scaleFactor: number; dataURL: string }): void;
		setTemplateImage(option: boolean): void;
	}

	interface WebContents {
		readonly id: number;
		isDestroyed(): boolean;
	}

	interface BrowserWindow {
		readonly webContents: WebContents;
		isDestroyed(): boolean;
		isVisible(): boolean;
		isMinimized(): boolean;
		show(): void;
		hide(): void;
		focus(): void;
		restore(): void;
		on(event: 'close', listener: (event: ElectronEvent) => void): this;
		removeListener(event: 'close', listener: (event: ElectronEvent) => void): this;
	}

	interface MenuItemConstructorOptions {
		label?: string;
		type?: 'normal' | 'separator';
		click?: () => void;
	}

	type Menu = object;

	interface Tray {
		setToolTip(toolTip: string): void;
		setContextMenu(menu: Menu | null): void;
		on(event: 'click', listener: () => void): this;
		destroy(): void;
		isDestroyed(): boolean;
	}

	type SecondInstanceListener = (event: ElectronEvent, argv: string[], workingDirectory: string) => void;

	interface App {
		quit(): void;
		getFileIcon(path: string, options?: { size?: 'small' | 'normal' | 'large' }): Promise<NativeImage>;
		on(event: 'second-instance', listener: SecondInstanceListener): this;
		on(event: 'activate', listener: () => void): this;
		removeListener(event: 'second-instance', listener: SecondInstanceListener): this;
		removeListener(event: 'activate', listener: () => void): this;
	}

	interface Remote {
		app: App;
		Tray: new (image: NativeImage) => Tray;
		Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu };
		nativeImage: {
			createEmpty(): NativeImage;
		};
		BrowserWindow: {
			getAllWindows(): BrowserWindow[];
			fromId(id: number): BrowserWindow | null;
		};
		webContents: { fromId(id: number): WebContents | undefined };
		getCurrentWindow(): BrowserWindow;
		/** Main-process `Reflect`; lets us read/write arbitrary properties on main-process objects. */
		getGlobal(name: 'Reflect'): typeof Reflect;
	}

	export const remote: Remote;
	export const ipcRenderer: {
		sendSync(channel: string, ...args: unknown[]): unknown;
	};
}
