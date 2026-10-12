import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  globalShortcut,
  Menu as ElectronMenu,
  nativeImage,
  screen,
  Tray as ElectronTray,
} from 'electron';

import { blockExternalNavigation, RENDERER_WEB_PREFERENCES } from './shell/security.js';
import type { Rect } from './shell/geometry.js';
import type { ScreenInfo, ScreenProvider } from './shell/placement.js';
import type {
  KeyEvent,
  KeyListener,
  PhysicalKey,
  Platform,
  ShortcutRegistration,
  TrayHost,
  TrayMenuItem,
  WindowFactory,
  WindowHandle,
  WindowKind,
  WindowOptions,
} from './shell/window.js';

export interface ElectronPlatformOptions {
  readonly onRendererError?: (source: string, error: unknown) => void;
}

const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = (file: string): string => join(here, 'renderer', file);
const preloadPath = join(here, 'preload.js');

const RENDERER_BY_KIND: Record<WindowKind, { file: string; width: number; height: number }> = {
  control_center: { file: 'control-center.html', width: 900, height: 640 },
  orb: { file: 'orb.html', width: 320, height: 320 },
  orb_backdrop: { file: 'orb-backdrop.html', width: 900, height: 640 },
  chat: { file: 'chat.html', width: 760, height: 640 },
};

const PHYSICAL_BY_CODE: Record<string, PhysicalKey> = {
  Slash: 'question',
  KeyA: 'a',
};

class ElectronKeyListener implements KeyListener {
  private readonly handlers = new Set<(event: KeyEvent) => void>();

  onKey(handler: (event: KeyEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  start(): void {}
  stop(): void {
    this.handlers.clear();
  }
  emit(event: KeyEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

class ElectronWindowHandle implements WindowHandle {
  readonly kind: WindowKind;
  private readonly window: BrowserWindow;
  private readonly onError: ((source: string, error: unknown) => void) | undefined;
  private loaded = false;
  private launchHidden: boolean;

  constructor(
    kind: WindowKind,
    window: BrowserWindow,
    onError?: (source: string, error: unknown) => void,
    launchHidden = false,
  ) {
    this.kind = kind;
    this.window = window;
    this.onError = onError;
    this.launchHidden = launchHidden;
  }

  get visible(): boolean {
    return this.window.isVisible();
  }

  show(): void {
    if (!this.loaded) {
      this.window
        .loadFile(rendererPath(RENDERER_BY_KIND[this.kind].file))
        .catch((error: unknown) => this.onError?.(`renderer:${this.kind}`, error));
      this.loaded = true;
      // Load for real so the Control Center is ready, but leave it hidden: a
      // login launch runs in the background until the user asks for a window.
      if (this.launchHidden) {
        this.launchHidden = false;
        return;
      }
    }
    this.window.showInactive();
  }
  focus(): void {
    this.window.focus();
  }
  hide(): void {
    this.window.hide();
  }
  close(): void {
    this.window.close();
  }
  setBounds(bounds: Rect): void {
    this.window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward?: boolean }): void {
    if (options?.forward === true) {
      this.window.setIgnoreMouseEvents(ignore, { forward: true });
      return;
    }
    this.window.setIgnoreMouseEvents(ignore);
  }
  setVisibleOnAllWorkspaces(visible: boolean): void {
    this.window.setVisibleOnAllWorkspaces(visible);
  }
  setAlwaysOnTop(alwaysOnTop: boolean, level?: string): void {
    this.window.setAlwaysOnTop(alwaysOnTop, level as never);
  }
}

class ElectronScreenProvider implements ScreenProvider {
  private info(display: Electron.Display): ScreenInfo {
    return {
      workArea: display.workArea,
      bounds: display.bounds,
      primary: display.id === screen.getPrimaryDisplay().id,
    };
  }
  primary(): ScreenInfo {
    return this.info(screen.getPrimaryDisplay());
  }
  displayNearestPoint(point: { readonly x: number; readonly y: number }): ScreenInfo {
    return this.info(screen.getDisplayNearestPoint(point));
  }
}

class ElectronWindowFactory implements WindowFactory {
  private readonly keys: ElectronKeyListener;
  private readonly onError: ((source: string, error: unknown) => void) | undefined;

  constructor(
    keys: ElectronKeyListener,
    onError?: (source: string, error: unknown) => void,
  ) {
    this.keys = keys;
    this.onError = onError;
  }

  create(kind: WindowKind, options: WindowOptions): WindowHandle {
    const spec = RENDERER_BY_KIND[kind];
    const bounds = options.bounds;
    const window = new BrowserWindow({
      width: Math.round(bounds?.width ?? spec.width),
      height: Math.round(bounds?.height ?? spec.height),
      ...(bounds !== undefined ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : {}),
      show: !options.startHidden && options.launchHidden !== true,
      frame: options.frame ?? true,
      transparent: options.transparent ?? false,
      alwaysOnTop: options.alwaysOnTop ?? false,
      focusable: options.focusable ?? true,
      hasShadow: options.hasShadow ?? true,
      skipTaskbar: options.skipTaskbar ?? kind === 'orb',
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.vibrancy !== undefined ? { vibrancy: options.vibrancy as never } : {}),
      // A non-activating native panel is what lets the Orb float over the
      // active app without ever becoming its key window; `type` is only honored
      // on macOS and is ignored elsewhere.
      ...(options.panel === true && process.platform === 'darwin'
        ? { type: 'panel' as const }
        : {}),
      webPreferences: {
        contextIsolation: RENDERER_WEB_PREFERENCES.contextIsolation,
        nodeIntegration: RENDERER_WEB_PREFERENCES.nodeIntegration,
        sandbox: RENDERER_WEB_PREFERENCES.sandbox,
        webSecurity: RENDERER_WEB_PREFERENCES.webSecurity,
        preload: preloadPath,
      },
    });
    if (options.alwaysOnTop === true && options.alwaysOnTopLevel !== undefined) {
      window.setAlwaysOnTop(true, options.alwaysOnTopLevel as never);
    }
    // A click-through presence must not swallow clicks aimed at the window
    // beneath it; input only reaches the Orb when it is not ignoring the mouse.
    if (options.clickThrough === true) {
      window.setIgnoreMouseEvents(true, { forward: true });
    }
    if (kind === 'orb' || kind === 'orb_backdrop') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    blockExternalNavigation({
      willNavigate: (handler) => window.webContents.on('will-navigate', (event) => handler(event.url)),
      setWindowOpenHandler: (handler) =>
        window.webContents.setWindowOpenHandler((details) => handler(details.url)),
    });
    const downKeys = new Set<PhysicalKey>();
    window.webContents.on('before-input-event', (_event, input) => {
      const key = PHYSICAL_BY_CODE[input.code];
      if (key === undefined) return;
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      if (input.type === 'keyDown') downKeys.add(key);
      else downKeys.delete(key);
      this.keys.emit({
        key,
        kind: input.type === 'keyDown' ? 'key_down' : 'key_up',
        repeat: input.isAutoRepeat,
      });
    });
    // A focused key released while the window lost focus never arrives as a
    // keyUp; without this a held push-to-talk would capture with no release.
    window.on('blur', () => {
      for (const key of downKeys) {
        this.keys.emit({ key, kind: 'key_up', repeat: false });
      }
      downKeys.clear();
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.onError?.(`render-process:${kind}`, details.reason);
    });
    return new ElectronWindowHandle(kind, window, this.onError, options.launchHidden === true);
  }
}

/**
 * The system tray. Creation can fail on a desktop with no status-notifier host;
 * that is reported as "not active" rather than thrown, so the app still runs in
 * the background.
 */
class DesktopTray implements TrayHost {
  private tray: ElectronTray | undefined;

  create(options: {
    readonly tooltip: string;
    readonly iconDataUrl: string;
    readonly items: readonly TrayMenuItem[];
  }): void {
    if (this.tray !== undefined) {
      this.setMenu(options.items);
      return;
    }
    try {
      const image = nativeImage.createFromDataURL(options.iconDataUrl);
      const tray = new ElectronTray(image.isEmpty() ? nativeImage.createEmpty() : image);
      tray.setToolTip(options.tooltip);
      tray.setContextMenu(this.buildMenu(options.items));
      this.tray = tray;
    } catch {
      this.tray = undefined;
    }
  }

  setMenu(items: readonly TrayMenuItem[]): void {
    this.tray?.setContextMenu(this.buildMenu(items));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }

  isActive(): boolean {
    return this.tray !== undefined;
  }

  private buildMenu(items: readonly TrayMenuItem[]): ElectronMenu {
    return ElectronMenu.buildFromTemplate(
      items.map((item) => ({ label: item.label, click: item.onClick })),
    );
  }
}

class ElectronShortcuts implements ShortcutRegistration {
  register(accelerator: string, handler: () => void): boolean {
    try {
      return globalShortcut.register(accelerator, handler);
    } catch {
      // An invalid accelerator throws; report it as "not registered" rather
      // than letting the failure escape and take the shell down.
      return false;
    }
  }
  isRegistered(accelerator: string): boolean {
    return globalShortcut.isRegistered(accelerator);
  }
  unregister(accelerator: string): void {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Releasing an unknown accelerator is a no-op, never a crash.
    }
  }
}

export function createElectronPlatform(options: ElectronPlatformOptions = {}): Platform {
  const keys = new ElectronKeyListener();
  return {
    windows: new ElectronWindowFactory(keys, options.onRendererError),
    keys,
    shortcuts: new ElectronShortcuts(),
    screen: new ElectronScreenProvider(),
    tray: new DesktopTray(),
  };
}
