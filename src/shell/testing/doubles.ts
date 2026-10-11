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
import type { ShellRuntime } from '../aria-shell.js';
import type { VoiceRuntimeLike } from '../interaction-runtime.js';

export class FakeWindowHandle implements WindowHandle {
  readonly kind: WindowKind;
  visible: boolean;
  shown = 0;
  focused = 0;
  hidden = 0;
  closed = 0;

  constructor(kind: WindowKind, options: WindowOptions) {
    this.kind = kind;
    this.visible = !options.startHidden;
  }

  show(): void {
    this.visible = true;
    this.shown += 1;
  }
  focus(): void {
    this.focused += 1;
  }
  hide(): void {
    this.visible = false;
    this.hidden += 1;
  }
  close(): void {
    this.visible = false;
    this.closed += 1;
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
  private readonly handlers = new Map<string, () => void>();

  register(accelerator: string, handler: () => void): void {
    this.accelerators.push(accelerator);
    this.handlers.set(accelerator, handler);
  }
  fire(accelerator: string): void {
    this.handlers.get(accelerator)?.();
  }
}

export class FakePlatform implements Platform {
  readonly windows = new FakeWindowFactory();
  readonly keys = new FakeKeyListener();
  readonly shortcuts = new FakeShortcutRegistration();
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

  async pushToTalkPress(): Promise<void> {
    this.presses += 1;
  }
  async pushToTalkRelease(): Promise<void> {
    this.releases += 1;
  }
  async sendText(text: string): Promise<void> {
    this.texts.push(text);
  }
  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }
}
