import type { Rect } from './geometry.js';
import type { ScreenProvider } from './placement.js';

export type WindowKind = 'control_center' | 'orb' | 'orb_backdrop' | 'chat';

export type PhysicalKey = 'f5' | 'a';

export type PushToTalkMode = 'hold' | 'toggle';

export interface KeyRepertoire {
  readonly pushToTalk: PhysicalKey;
  readonly chatShortcut: PhysicalKey;
}

export const DEFAULT_KEY_REPERTOIRE: KeyRepertoire = {
  pushToTalk: 'f5',
  chatShortcut: 'a',
};

export interface WindowHandle {
  readonly kind: WindowKind;
  readonly visible: boolean;
  /** Whether the window is gone; acting on a destroyed window throws. */
  isDestroyed(): boolean;
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
  /**
   * When true, the first `show()` only paints the window without revealing it,
   * so an app launched at login can preload the Control Center and still stay in
   * the background until the user asks for it.
   */
  readonly launchHidden?: boolean;
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
  /** A native translucent material, e.g. macOS `vibrancy` or Windows acrylic. */
  readonly vibrancy?: string;
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
  /** Register an accelerator; returns whether the OS accepted the grab. */
  register(accelerator: string, handler: () => void): boolean;
  /** Release an accelerator previously registered. Idempotent. */
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface Platform {
  readonly windows: WindowFactory;
  readonly keys: KeyListener;
  readonly shortcuts: ShortcutRegistration;
  readonly screen: ScreenProvider;
  /**
   * The system tray, when the desktop provides one. Omitted means no tray; the
   * app still runs in the background, it just has no tray affordance.
   */
  readonly tray?: TrayHost;
}

export interface TrayMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void;
}

export interface TrayHost {
  /** Create the tray icon with its menu. Idempotent per process. */
  create(options: {
    readonly tooltip: string;
    readonly iconDataUrl: string;
    readonly items: readonly TrayMenuItem[];
  }): void;
  /** Replace the menu items, e.g. after the Orb visibility changes. */
  setMenu(items: readonly TrayMenuItem[]): void;
  destroy(): void;
  /** Whether a tray was created (the desktop may not support one). */
  isActive(): boolean;
}

export const CHAT_SHORTCUT_ACCELERATORS = [
  'Super+Alt+A',
  'Control+Alt+A',
  'Super+Shift+A',
  'Control+Shift+A',
] as const;

/**
 * The chat accelerator the app prefers. Desktop environments grab many
 * Super/Alt combinations, so registration walks the candidate list and uses the
 * first the OS actually accepts rather than assuming the preferred one is free.
 */
export const CHAT_SHORTCUT_ACCELERATOR = CHAT_SHORTCUT_ACCELERATORS[0];

/**
 * A true global push-to-talk accelerator. Unlike the focused `F5` key, this is
 * grabbed from the OS, so it fires while another application has focus.
 *
 * A global accelerator only reports the key going down, never its release, so
 * the shell treats each press as a tap and defers to the voice controller's
 * mode: `toggle` finalizes on the next tap, while `hold` pairs each tap with a
 * release so capture cannot run forever. True hold-to-talk remains available
 * through the focused `F5` key.
 *
 * `Super+Alt+T` is the supreme grab: it is registered first and is the toggle
 * the user can rely on. A desktop environment often holds Super-based
 * combinations (GNOME binds them freely), so registration falls back through
 * the candidate list and keeps the first the OS accepts.
 */
export const PUSH_TO_TALK_ACCELERATORS = [
  'Super+Alt+T',
  'Super+Alt+Space',
  'Control+Alt+T',
  'Control+Alt+Space',
  'Super+Shift+T',
] as const;

export const PUSH_TO_TALK_ACCELERATOR = PUSH_TO_TALK_ACCELERATORS[0];
