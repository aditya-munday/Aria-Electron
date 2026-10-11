export type WindowKind = 'control_center' | 'orb' | 'chat';

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
}

export interface WindowOptions {
  readonly startHidden: boolean;
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
}

export const CHAT_SHORTCUT_ACCELERATOR = 'CommandOrControl+Alt+A';
