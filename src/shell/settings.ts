import type { PushToTalkMode, WindowKind } from './window.js';

export interface ShellSettings {
  readonly openWindows: readonly WindowKind[];
  readonly wakeWordEnabled: boolean;
  readonly pushToTalkEnabled: boolean;
  readonly pushToTalkMode: PushToTalkMode;
  readonly chatShortcutEnabled: boolean;
  readonly captureMuted: boolean;
  readonly showOrb: boolean;
  readonly startOnLogin: boolean;
  readonly accent: AccentTheme;
  readonly voice?: string;
  readonly language?: string;
  readonly speakResponses: boolean;
  /** Synthesis speed multiplier; 1 is the Backend default. */
  readonly speechRate: number;
  readonly captureDeviceId?: string;
}

export type AccentTheme = 'aurora' | 'mint' | 'amber' | 'rose';

export const ACCENT_THEMES: readonly AccentTheme[] = ['aurora', 'mint', 'amber', 'rose'];

export const DEFAULT_SETTINGS: ShellSettings = {
  openWindows: ['control_center'],
  wakeWordEnabled: false,
  pushToTalkEnabled: true,
  pushToTalkMode: 'hold',
  chatShortcutEnabled: true,
  captureMuted: false,
  showOrb: true,
  startOnLogin: false,
  accent: 'aurora',
  speakResponses: true,
  speechRate: 1,
};

export interface SettingsStore {
  load(): ShellSettings;
  save(settings: ShellSettings): void;
  subscribe?(listener: (settings: ShellSettings) => void): () => void;
}

const WINDOW_KINDS: ReadonlySet<string> = new Set(['control_center', 'orb', 'chat']);

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === 'string' && (ACCENT_THEMES as readonly string[]).includes(value);
}

function normalizeSpeechRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.speechRate;
  return Math.min(2, Math.max(0.5, value));
}

export function normalizeSettings(value: unknown): ShellSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const record = value as Record<string, unknown>;
  const openWindows = Array.isArray(record['openWindows'])
    ? (record['openWindows'].filter((entry): entry is WindowKind => WINDOW_KINDS.has(entry as string)) as WindowKind[])
    : DEFAULT_SETTINGS.openWindows;
  const voice = optionalId(record['voice']);
  const language = optionalId(record['language']);
  const captureDeviceId = optionalId(record['captureDeviceId']);
  return {
    openWindows,
    wakeWordEnabled:
      typeof record['wakeWordEnabled'] === 'boolean'
        ? record['wakeWordEnabled']
        : DEFAULT_SETTINGS.wakeWordEnabled,
    pushToTalkEnabled:
      typeof record['pushToTalkEnabled'] === 'boolean'
        ? record['pushToTalkEnabled']
        : DEFAULT_SETTINGS.pushToTalkEnabled,
    pushToTalkMode:
      record['pushToTalkMode'] === 'hold' || record['pushToTalkMode'] === 'toggle'
        ? record['pushToTalkMode']
        : DEFAULT_SETTINGS.pushToTalkMode,
    chatShortcutEnabled:
      typeof record['chatShortcutEnabled'] === 'boolean'
        ? record['chatShortcutEnabled']
        : DEFAULT_SETTINGS.chatShortcutEnabled,
    captureMuted:
      typeof record['captureMuted'] === 'boolean'
        ? record['captureMuted']
        : DEFAULT_SETTINGS.captureMuted,
    showOrb:
      typeof record['showOrb'] === 'boolean' ? record['showOrb'] : DEFAULT_SETTINGS.showOrb,
    startOnLogin:
      typeof record['startOnLogin'] === 'boolean'
        ? record['startOnLogin']
        : DEFAULT_SETTINGS.startOnLogin,
    accent: isAccentTheme(record['accent']) ? record['accent'] : DEFAULT_SETTINGS.accent,
    speakResponses:
      typeof record['speakResponses'] === 'boolean'
        ? record['speakResponses']
        : DEFAULT_SETTINGS.speakResponses,
    speechRate: normalizeSpeechRate(record['speechRate']),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(captureDeviceId !== undefined ? { captureDeviceId } : {}),
  };
}

export class InMemorySettingsStore implements SettingsStore {
  private current: ShellSettings;
  private readonly listeners = new Set<(settings: ShellSettings) => void>();
  constructor(initial: ShellSettings = DEFAULT_SETTINGS) {
    this.current = normalizeSettings(initial);
  }
  load(): ShellSettings {
    return this.current;
  }
  save(settings: ShellSettings): void {
    this.current = normalizeSettings(settings);
    for (const listener of this.listeners) listener(this.current);
  }
  subscribe(listener: (settings: ShellSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface SettingsPatchInput {
  readonly wakeWordEnabled?: boolean;
  readonly pushToTalkEnabled?: boolean;
  readonly pushToTalkMode?: PushToTalkMode;
  readonly chatShortcutEnabled?: boolean;
  readonly captureMuted?: boolean;
  readonly showOrb?: boolean;
  readonly startOnLogin?: boolean;
  readonly accent?: AccentTheme;
  readonly voice?: string | null;
  readonly language?: string | null;
  readonly speakResponses?: boolean;
  readonly speechRate?: number;
  readonly captureDeviceId?: string | null;
}

export function patchSettings(
  current: ShellSettings,
  patch: SettingsPatchInput,
): ShellSettings {
  const next = patch as Record<string, unknown>;
  const voice = current.voice;
  const language = current.language;
  const captureDeviceId = current.captureDeviceId;
  const merged: Record<string, unknown> = {
    ...current,
    ...(patch.wakeWordEnabled !== undefined ? { wakeWordEnabled: patch.wakeWordEnabled } : {}),
    ...(patch.pushToTalkEnabled !== undefined
      ? { pushToTalkEnabled: patch.pushToTalkEnabled }
      : {}),
    ...(patch.pushToTalkMode !== undefined ? { pushToTalkMode: patch.pushToTalkMode } : {}),
    ...(patch.chatShortcutEnabled !== undefined
      ? { chatShortcutEnabled: patch.chatShortcutEnabled }
      : {}),
    ...(patch.captureMuted !== undefined ? { captureMuted: patch.captureMuted } : {}),
    ...(patch.showOrb !== undefined ? { showOrb: patch.showOrb } : {}),
    ...(patch.startOnLogin !== undefined ? { startOnLogin: patch.startOnLogin } : {}),
    ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
    ...(patch.speakResponses !== undefined ? { speakResponses: patch.speakResponses } : {}),
    ...(patch.speechRate !== undefined ? { speechRate: patch.speechRate } : {}),
  };
  if (next['voice'] === null) {
    delete merged['voice'];
  } else if (patch.voice !== undefined) {
    merged['voice'] = patch.voice;
  } else if (voice !== undefined) {
    merged['voice'] = voice;
  }
  if (next['language'] === null) {
    delete merged['language'];
  } else if (patch.language !== undefined) {
    merged['language'] = patch.language;
  } else if (language !== undefined) {
    merged['language'] = language;
  }
  if (next['captureDeviceId'] === null) {
    delete merged['captureDeviceId'];
  } else if (patch.captureDeviceId !== undefined) {
    merged['captureDeviceId'] = patch.captureDeviceId;
  } else if (captureDeviceId !== undefined) {
    merged['captureDeviceId'] = captureDeviceId;
  }
  return normalizeSettings(merged);
}
