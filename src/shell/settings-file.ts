import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
      // A direct write truncates first: a crash mid-write would leave an empty
      // or half-written file, which the next load silently reads as defaults and
      // the user's settings vanish. Write a sibling and rename over the target
      // instead — rename is atomic on POSIX, so readers only ever see a whole
      // file. The owner-only mode keeps the file private like the token store.
      const temporary = `${path}.tmp-${process.pid}`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, path);
        chmodSync(path, 0o600);
      } catch {
        // A failed persist is not fatal; the in-memory settings remain correct
        // and the subscribers below are still notified.
      }
      for (const listener of listeners) listener(settings);
    },
    subscribe: (listener: (settings: ShellSettings) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
