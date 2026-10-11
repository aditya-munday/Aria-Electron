import type { WindowKind } from './window.js';

export interface ShellSettings {
  readonly openWindows: readonly WindowKind[];
  readonly wakeWordEnabled: boolean;
  readonly pushToTalkEnabled: boolean;
  readonly captureDeviceId?: string;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  openWindows: ['control_center'],
  wakeWordEnabled: false,
  pushToTalkEnabled: true,
};

export interface SettingsStore {
  load(): ShellSettings;
  save(settings: ShellSettings): void;
}

export function normalizeSettings(value: unknown): ShellSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const record = value as Record<string, unknown>;
  const openWindows = Array.isArray(record['openWindows'])
    ? (record['openWindows'].filter(
        (entry): entry is WindowKind =>
          entry === 'control_center' || entry === 'orb' || entry === 'chat',
      ) as WindowKind[])
    : DEFAULT_SETTINGS.openWindows;
  const captureDeviceId =
    typeof record['captureDeviceId'] === 'string' && record['captureDeviceId'].trim() !== ''
      ? record['captureDeviceId']
      : undefined;
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
    ...(captureDeviceId !== undefined ? { captureDeviceId } : {}),
  };
}

export class InMemorySettingsStore implements SettingsStore {
  private current: ShellSettings;
  constructor(initial: ShellSettings = DEFAULT_SETTINGS) {
    this.current = initial;
  }
  load(): ShellSettings {
    return this.current;
  }
  save(settings: ShellSettings): void {
    this.current = settings;
  }
}
