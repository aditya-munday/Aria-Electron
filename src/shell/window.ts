import type { Rect } from './geometry.js';
import type { ScreenProvider } from './placement.js';

export type WindowKind = 'control_center' | 'orb' | 'orb_backdrop' | 'chat';

export type PhysicalKey = 'question' | 'a';

export type PushToTalkMode = 'hold' | 'toggle';

export interface KeyRepertoire {
  readonly pushToTalk: PhysicalKey;
  readonly chatShortcut: PhysicalKey;
}

export const DEFAULT_KEY_REPERTOIRE: KeyRepertoire = {
  pushToTalk: 'question',
  chatShortcut: 'a',
};

export interface WindowHandle {
  readonly kind: WindowKind;
  readonly visible: boolean;
  show(): void;
  focus(): void;
  hide(): void;
  close(): void;
  setBounds(bounds: Rect): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { readonly forward?: boolean }): void;
  setVisibleOnAllWorkspaces(visible: boolean): void;
  setAlwaysOnTop(alwaysOnTop: boolean, level?: string): void;
}

export interface WindowOptions {
  readonly startHidden: boolean;
  readonly frame?: boolean;
  readonly transparent?: boolean;
  readonly alwaysOnTop?: boolean;
  readonly clickThrough?: boolean;
  readonly focusable?: boolean;
  readonly hasShadow?: boolean;
  readonly skipTaskbar?: boolean;
  readonly title?: string;
  readonly bounds?: Rect;
  /**
   * A native macOS panel. The window becomes a non-activating presence that
   * floats over full-screen apps; it is ignored on other platforms.
   */
  readonly panel?: boolean;
  /** The always-on-top level, e.g. `screen-saver`, `floating`. */
  readonly alwaysOnTopLevel?: string;
}

export interface WindowFactory {
  create(kind: WindowKind, options: WindowOptions): WindowHandle;
}

export interface KeyEvent {
  readonly key: PhysicalKey;
  readonly kind: 'key_down' | 'key_up';
  readonly repeat: boolean;
}

export interface KeyListener {
  onKey(handler: (event: KeyEvent) => void): () => void;
  start(): void;
  stop(): void;
}

export interface ShortcutRegistration {
  register(accelerator: string, handler: () => void): void;
}

export interface Platform {
  readonly windows: WindowFactory;
  readonly keys: KeyListener;
  readonly shortcuts: ShortcutRegistration;
  readonly screen: ScreenProvider;
}

export const CHAT_SHORTCUT_ACCELERATOR = 'CommandOrControl+Alt+A';
