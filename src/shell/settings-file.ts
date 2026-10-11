import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type SettingsStore,
  type ShellSettings,
} from './settings.js';

export function createFileSettingsStore(directory: string): SettingsStore {
  const path = join(directory, 'shell-settings.json');
  const listeners = new Set<(settings: ShellSettings) => void>();
  return {
    load: (): ShellSettings => {
      try {
        return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },
    save: (settings: ShellSettings): void => {
      try {
        writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
      } catch {
      }
      for (const listener of listeners) listener(settings);
    },
    subscribe: (listener: (settings: ShellSettings) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
