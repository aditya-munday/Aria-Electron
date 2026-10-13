import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileSettingsStore } from './settings-file.js';
import { DEFAULT_SETTINGS, type ShellSettings } from './settings.js';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aria-settings-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createFileSettingsStore', () => {
  it('returns defaults when no file exists', () => {
    withTempDir((dir) => {
      const store = createFileSettingsStore(dir);
      expect(store.load()).toEqual({ ...DEFAULT_SETTINGS });
    });
  });

  it('round-trips settings through the file', () => {
    withTempDir((dir) => {
      const store = createFileSettingsStore(dir);
      const next: ShellSettings = { ...DEFAULT_SETTINGS, accent: 'rose', speechRate: 1.5 };
      store.save(next);
      expect(store.load()).toMatchObject({ accent: 'rose', speechRate: 1.5 });
    });
  });

  it('writes the settings file with owner-only permissions and no temp left behind', () => {
    withTempDir((dir) => {
      const store = createFileSettingsStore(dir);
      store.save({ ...DEFAULT_SETTINGS });
      const path = join(dir, 'shell-settings.json');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // The atomic-write sibling must be renamed away, never left in the dir.
      expect(readdirSync(dir)).toEqual(['shell-settings.json']);
    });
  });

  it('replaces the file atomically so no partial content is ever readable', () => {
    withTempDir((dir) => {
      const store = createFileSettingsStore(dir);
      store.save({ ...DEFAULT_SETTINGS, accent: 'aurora' });
      store.save({ ...DEFAULT_SETTINGS, accent: 'amber' });
      const raw = readFileSync(join(dir, 'shell-settings.json'), 'utf8');
      // The file always parses as whole JSON — never an empty/truncated read.
      expect(JSON.parse(raw)).toMatchObject({ accent: 'amber' });
    });
  });

  it('normalizes a corrupt file back to defaults instead of throwing', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'shell-settings.json'), '{ not json', 'utf8');
      const store = createFileSettingsStore(dir);
      expect(store.load()).toEqual({ ...DEFAULT_SETTINGS });
    });
  });

  it('notifies subscribers on save', () => {
    withTempDir((dir) => {
      const store = createFileSettingsStore(dir);
      const seen: ShellSettings[] = [];
      store.subscribe?.((next) => seen.push(next));
      store.save({ ...DEFAULT_SETTINGS, accent: 'mint' });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.accent).toBe('mint');
    });
  });
});
