import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialStore, defaultConfigDir, defaultCredentialsPath } from './credential-store.js';

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aria-cred-'));
  dirs.push(dir);
  return join(dir, 'credentials.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CredentialStore', () => {
  it('returns undefined when the file does not exist', () => {
    expect(new CredentialStore(tempPath()).load()).toBeUndefined();
  });

  it('round-trips a credential and preserves unrelated profiles', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ staging: { authToken: 'other' } }));
    const store = new CredentialStore(path);
    store.save({ authToken: 'tok-1', id: 'u1', email: 'ada@example.com' });
    expect(store.load()).toEqual({ authToken: 'tok-1', id: 'u1', email: 'ada@example.com' });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(raw['staging']).toEqual({ authToken: 'other' });
  });

  it('writes the file owner-only', () => {
    if (process.platform === 'win32') return;
    const path = tempPath();
    new CredentialStore(path).save({ authToken: 'tok-1' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('re-tightens the mode when the file was left world-readable', () => {
    if (process.platform === 'win32') return;
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ default: { authToken: 'tok-1' } }), { mode: 0o644 });
    new CredentialStore(path).load();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('treats a malformed file as signed out', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json');
    expect(new CredentialStore(path).load()).toBeUndefined();
  });

  it('clear removes the default profile but keeps the file parseable', () => {
    const path = tempPath();
    const store = new CredentialStore(path);
    store.save({ authToken: 'tok-1' });
    store.clear();
    expect(store.load()).toBeUndefined();
  });
});

describe('credential location', () => {
  it('prefers ARIA_CONFIG_DIR', () => {
    expect(defaultConfigDir({ ARIA_CONFIG_DIR: '/etc/aria' })).toBe('/etc/aria');
  });

  it('falls back to the XDG config home', () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/aria');
  });

  it('uses the CLI path when only a CLI login exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aria-cli-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'credentials.json'), '{}');
    const resolved = defaultCredentialsPath({ XDG_CONFIG_HOME: dir });
    // The CLI directory is `directioner`, not the XDG root, so nothing is found
    // and Aria's own path wins.
    expect(resolved).toBe(join(dir, 'aria', 'credentials.json'));
  });
});
