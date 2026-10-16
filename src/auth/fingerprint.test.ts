import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deviceFingerprintId, loadOrCreateFingerprintId } from './fingerprint.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aria-fp-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateFingerprintId', () => {
  it('creates an id once and returns the same value on the next call', () => {
    const path = join(tempDir(), 'fingerprint-id');
    const first = loadOrCreateFingerprintId({ ARIA_FINGERPRINT_PATH: path });
    const second = loadOrCreateFingerprintId({ ARIA_FINGERPRINT_PATH: path });
    expect(first).toBe(second);
    expect(first).not.toBe('');
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
  });

  it('reuses an existing id', () => {
    const path = join(tempDir(), 'fingerprint-id');
    writeFileSync(path, 'persisted-id\n');
    expect(loadOrCreateFingerprintId({ ARIA_FINGERPRINT_PATH: path })).toBe('persisted-id');
  });

  it('falls back to the host hash when the path cannot be written', () => {
    // A directory at the file path makes the write fail; the host hash is used.
    const dir = tempDir();
    const id = loadOrCreateFingerprintId({ ARIA_FINGERPRINT_PATH: dir });
    expect(id).toBe(deviceFingerprintId());
  });
});
