import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserWindow,
  globalShortcut,
  screen,
} from 'electron';

import { applyWebContentsHardening, appPageUrl, hardenedWebPreferences } from './shell/security.js';
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

export interface ElectronPlatformOptions {
  readonly onRendererError?: (source: string, error: unknown) => void;
  /** Called when a window closes, so the shell can drop its dead handle. */
  readonly onWindowClosed?: (kind: WindowKind) => void;
}

const here = dirname(fileURLToPath(import.meta.url));
const rendererUrl = (file: string): string => appPageUrl(file);
const preloadPath = join(here, 'preload.cjs');

const RENDERER_BY_KIND: Record<WindowKind, { file: string; width: number; height: number }> = {
  control_center: { file: 'control-center.html', width: 900, height: 640 },
  orb: { file: 'orb.html', width: 320, height: 320 },
  orb_backdrop: { file: 'orb-backdrop.html', width: 900, height: 640 },
  chat: { file: 'chat.html', width: 760, height: 640 },
  // The voice window is a hidden renderer that owns the microphone: it is never
  // shown, so its size is nominal.
  voice: { file: 'voice.html', width: 1, height: 1 },
};

const PHYSICAL_BY_CODE: Record<string, PhysicalKey> = {
  F5: 'f5',
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
  private destroyed = false;

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
    // Reading a destroyed window throws, so a teardown that races a settings
    // read must report not-visible rather than crash the shell.
    return !this.isDestroyed() && this.window.isVisible();
  }

  isDestroyed(): boolean {
    return this.destroyed || this.window.isDestroyed();
  }

  /** Load the page without revealing the window. Idempotent. */
  load(): void {
    if (this.isDestroyed() || this.loaded) return;
    this.loaded = true;
    this.window
      .loadURL(rendererUrl(RENDERER_BY_KIND[this.kind].file))
      .catch((error: unknown) => this.onError?.(`renderer:${this.kind}`, error));
  }

  show(): void {
    if (this.isDestroyed()) return;
    if (!this.loaded) {
      this.window
        .loadURL(rendererUrl(RENDERER_BY_KIND[this.kind].file))
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
    if (this.isDestroyed()) return;
    this.window.focus();
  }
  hide(): void {
    if (this.isDestroyed()) return;
    this.window.hide();
  }
  close(): void {
    if (this.isDestroyed()) return;
    this.window.close();
  }
  send(channel: string, ...args: readonly unknown[]): void {
    if (this.isDestroyed()) return;
    this.window.webContents.send(channel, ...args);
  }
  setBounds(bounds: Rect): void {
    if (this.isDestroyed()) return;
    this.window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward?: boolean }): void {
    if (this.isDestroyed()) return;
    if (options?.forward === true) {
      this.window.setIgnoreMouseEvents(ignore, { forward: true });
      return;
    }
    this.window.setIgnoreMouseEvents(ignore);
  }
  setVisibleOnAllWorkspaces(visible: boolean): void {
    if (this.isDestroyed()) return;
    this.window.setVisibleOnAllWorkspaces(visible);
  }
  setAlwaysOnTop(alwaysOnTop: boolean, level?: string): void {
    if (this.isDestroyed()) return;
    this.window.setAlwaysOnTop(alwaysOnTop, level as never);
  }
  /** Called by the factory when the window closes, so the shell drops it. */
  markDestroyed(): void {
    this.destroyed = true;
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
  private readonly onClosed: ((kind: WindowKind) => void) | undefined;

  constructor(
    keys: ElectronKeyListener,
    onError?: (source: string, error: unknown) => void,
    onClosed?: (kind: WindowKind) => void,
  ) {
    this.keys = keys;
    this.onError = onError;
    this.onClosed = onClosed;
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
        ...hardenedWebPreferences(preloadPath),
        // The voice window captures the microphone while hidden; throttling a
        // backgrounded renderer would stall its audio pipeline.
        ...(kind === 'voice' ? { backgroundThrottling: false } : {}),
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
    applyWebContentsHardening(window.webContents);
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
    const handle = new ElectronWindowHandle(
      kind,
      window,
      this.onError,
      options.launchHidden === true,
    );
    // The hidden voice window must run its renderer (which owns the microphone)
    // immediately; nothing ever calls show() on it, so load it here.
    if (kind === 'voice') handle.load();
    // A closed window leaves a dead handle behind; mark it destroyed and tell
    // the shell to drop it so nothing acts on a destroyed BrowserWindow.
    window.on('closed', () => {
      handle.markDestroyed();
      this.onClosed?.(kind);
    });
    return handle;
  }
}

/**
 * The global shortcuts. A registration that the OS refuses is reported, never
 * assumed, so the shell can fall back to an in-window control.
 */
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
    windows: new ElectronWindowFactory(keys, options.onRendererError, options.onWindowClosed),
    keys,
    shortcuts: new ElectronShortcuts(),
    screen: new ElectronScreenProvider(),
  };
}
