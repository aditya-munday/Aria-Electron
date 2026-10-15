import type {
  KeyEvent,
  KeyListener,
  Platform,
  ShortcutRegistration,
  WindowFactory,
  WindowHandle,
  WindowKind,
  WindowOptions,
} from '../window.js';
import type { Rect } from '../geometry.js';
import type { RouteHint } from '../../contract/aria-contract.js';
import type { ScreenInfo, ScreenProvider } from '../placement.js';
import type { ShellRuntime } from '../aria-shell.js';
import type { VoiceRuntimeLike } from '../interaction-runtime.js';

export class FakeWindowHandle implements WindowHandle {
  readonly kind: WindowKind;
  readonly options: WindowOptions;
  visible: boolean;
  bounds: Rect;
  ignoreMouse = false;
  ignoreMouseForward = false;
  ignoreMouseCalls: boolean[] = [];
  onAllWorkspaces = false;
  alwaysOnTopLevel: string | undefined;
  shown = 0;
  focused = 0;
  hidden = 0;
  closed = 0;
  loaded = 0;
  readonly sent: { channel: string; args: readonly unknown[] }[] = [];
  private destroyed = false;
  private launchHiddenConsumed = false;

  constructor(kind: WindowKind, options: WindowOptions) {
    this.kind = kind;
    this.options = options;
    this.visible = !options.startHidden && options.launchHidden !== true;
    this.bounds = options.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    this.ignoreMouse = options.clickThrough === true;
    this.ignoreMouseForward = options.clickThrough === true;
    this.alwaysOnTopLevel = options.alwaysOnTopLevel;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Simulate the OS destroying the window (as on a user close). */
  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }

  load(): void {
    if (this.destroyed) return;
    this.loaded += 1;
  }

  send(channel: string, ...args: readonly unknown[]): void {
    if (this.destroyed) return;
    this.sent.push({ channel, args });
  }

  show(): void {
    if (this.destroyed) return;
    if (this.options.launchHidden === true && !this.launchHiddenConsumed) {
      this.launchHiddenConsumed = true;
      return;
    }
    this.visible = true;
    this.shown += 1;
  }
  focus(): void {
    if (this.destroyed) return;
    this.focused += 1;
  }
  hide(): void {
    if (this.destroyed) return;
    this.visible = false;
    this.hidden += 1;
  }
  close(): void {
    this.visible = false;
    this.closed += 1;
    this.destroyed = true;
  }
  setBounds(bounds: Rect): void {
    this.bounds = bounds;
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward?: boolean }): void {
    this.ignoreMouse = ignore;
    this.ignoreMouseForward = options?.forward ?? false;
    this.ignoreMouseCalls.push(ignore);
  }
  setVisibleOnAllWorkspaces(visible: boolean): void {
    this.onAllWorkspaces = visible;
  }
  setAlwaysOnTop(_alwaysOnTop: boolean, level?: string): void {
    this.alwaysOnTopLevel = level ?? this.alwaysOnTopLevel;
  }
}

export class FakeWindowFactory implements WindowFactory {
  readonly created: FakeWindowHandle[] = [];
  private readonly byKind = new Map<WindowKind, FakeWindowHandle>();

  create(kind: WindowKind, options: WindowOptions): WindowHandle {
    const handle = new FakeWindowHandle(kind, options);
    this.created.push(handle);
    this.byKind.set(kind, handle);
    return handle;
  }

  handle(kind: WindowKind): FakeWindowHandle | undefined {
    return this.byKind.get(kind);
  }
}

export class FakeScreenProvider implements ScreenProvider {
  constructor(
    readonly primaryScreen: ScreenInfo = {
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      primary: true,
    },
  ) {}

  primary(): ScreenInfo {
    return this.primaryScreen;
  }
  displayNearestPoint(): ScreenInfo {
    return this.primaryScreen;
  }
}

export class FakeKeyListener implements KeyListener {
  started = 0;
  stopped = 0;
  private handler: ((event: KeyEvent) => void) | undefined;

  onKey(handler: (event: KeyEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  emit(event: KeyEvent): void {
    this.handler?.(event);
  }
}

export class FakeShortcutRegistration implements ShortcutRegistration {
  readonly accelerators: string[] = [];
  readonly refused: string[] = [];
  private readonly handlers = new Map<string, () => void>();
  private readonly registered = new Set<string>();

  register(accelerator: string, handler: () => void): boolean {
    this.accelerators.push(accelerator);
    if (this.refused.includes(accelerator)) return false;
    this.handlers.set(accelerator, handler);
    this.registered.add(accelerator);
    return true;
  }
  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator);
  }
  unregister(accelerator: string): void {
    this.handlers.delete(accelerator);
    this.registered.delete(accelerator);
  }
  fire(accelerator: string): void {
    this.handlers.get(accelerator)?.();
  }
}

export class FakePlatform implements Platform {
  readonly windows = new FakeWindowFactory();
  readonly keys = new FakeKeyListener();
  readonly shortcuts = new FakeShortcutRegistration();
  readonly screen = new FakeScreenProvider();
}

export class FakeShellRuntime implements ShellRuntime {
  started = 0;
  start(): void {
    this.started += 1;
  }
}

export class FakeVoiceRuntime implements VoiceRuntimeLike {
  presses = 0;
  releases = 0;
  readonly texts: string[] = [];
  interrupts = 0;
  reply: { readonly text: string; readonly route?: RouteHint | null } = { text: '' };

  async pushToTalkPress(): Promise<void> {
    this.presses += 1;
  }
  async pushToTalkRelease(): Promise<void> {
    this.releases += 1;
  }
  async sendText(text: string): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    this.texts.push(text);
    return this.reply;
  }
  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }
}
