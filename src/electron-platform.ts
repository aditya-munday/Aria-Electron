import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, globalShortcut, screen } from 'electron';

import { blockExternalNavigation, RENDERER_WEB_PREFERENCES } from './shell/security.js';
import type { Rect } from './shell/geometry.js';
import type { ScreenInfo, ScreenProvider } from './shell/placement.js';
import type {
  KeyEvent,
  KeyListener,
  PhysicalKey,
  Platform,
  ShortcutRegistration,
  WindowFactory,
  WindowHandle,
  WindowKind,
  WindowOptions,
} from './shell/window.js';

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
  private loaded = false;

  constructor(kind: WindowKind, window: BrowserWindow) {
    this.kind = kind;
    this.window = window;
  }

  get visible(): boolean {
    return this.window.isVisible();
  }

  show(): void {
    if (!this.loaded) {
      void this.window.loadFile(rendererPath(RENDERER_BY_KIND[this.kind].file));
      this.loaded = true;
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

  constructor(keys: ElectronKeyListener) {
    this.keys = keys;
  }

  create(kind: WindowKind, options: WindowOptions): WindowHandle {
    const spec = RENDERER_BY_KIND[kind];
    const bounds = options.bounds;
    const window = new BrowserWindow({
      width: Math.round(bounds?.width ?? spec.width),
      height: Math.round(bounds?.height ?? spec.height),
      ...(bounds !== undefined ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : {}),
      show: !options.startHidden,
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
    window.webContents.on('before-input-event', (_event, input) => {
      const key = PHYSICAL_BY_CODE[input.code];
      if (key === undefined) return;
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      this.keys.emit({
        key,
        kind: input.type === 'keyDown' ? 'key_down' : 'key_up',
        repeat: input.isAutoRepeat,
      });
    });
    return new ElectronWindowHandle(kind, window);
  }
}

class ElectronShortcuts implements ShortcutRegistration {
  register(accelerator: string, handler: () => void): void {
    globalShortcut.register(accelerator, handler);
  }
}

export function createElectronPlatform(): Platform {
  const keys = new ElectronKeyListener();
  return {
    windows: new ElectronWindowFactory(keys),
    keys,
    shortcuts: new ElectronShortcuts(),
    screen: new ElectronScreenProvider(),
  };
}
