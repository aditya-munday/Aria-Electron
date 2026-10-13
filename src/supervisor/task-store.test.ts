import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTaskStore, InMemoryTaskStore } from './task-store.js';
import type { SupervisionRecord } from './task-store.js';

function record(taskId: string): SupervisionRecord {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: 'accepted',
    version: 1,
    origin: 'aria',
    cancellation: 'none',
    verification: 'unverified',
    lastSequence: 0,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
  };
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aria-store-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('InMemoryTaskStore', () => {
  it('hands out copies so a caller cannot mutate the stored record', () => {
    const store = new InMemoryTaskStore();
    store.put(record('t1'));
    const fetched = store.get('t1') as SupervisionRecord;
    (fetched as { title: string }).title = 'mutated';
    expect(store.get('t1')?.title).toBe('Task t1');
  });
});

describe('FileTaskStore', () => {
  it('survives a reload from disk (durability across restart)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'supervision.json');
      const first = new FileTaskStore(path);
      first.load();
      first.put(record('t1'));

      const second = new FileTaskStore(path);
      second.load();
      expect(second.get('t1')?.title).toBe('Task t1');
    });
  });

  it('treats a corrupt file as empty rather than crashing', () => {
    withTempDir((dir) => {
      const path = join(dir, 'supervision.json');
      writeFileSync(path, '{ not json', 'utf8');
      const store = new FileTaskStore(path);
      store.load();
      expect(store.all()).toEqual([]);
    });
  });

  it('starts empty when the file does not exist yet', () => {
    withTempDir((dir) => {
      const store = new FileTaskStore(join(dir, 'missing.json'));
      store.load();
      expect(store.all()).toEqual([]);
    });
  });

  it('leaves no temp file behind after a write', () => {
    withTempDir((dir) => {
      const path = join(dir, 'supervision.json');
      const store = new FileTaskStore(path);
      store.load();
      store.put(record('t1'));
      store.remove('t1');
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ records: [] });
    });
  });
});
