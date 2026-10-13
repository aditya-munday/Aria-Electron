import { describe, expect, it, vi } from 'vitest';

import { AccountManager } from './account.js';
import type { DeviceLoginClient, LoginPollResult } from './device-login.js';
import type { StoredCredential } from './credential-store.js';

function fakeStore(initial?: StoredCredential) {
  let value = initial;
  return {
    load: () => value,
    save: (credential: StoredCredential) => {
      value = credential;
    },
    clear: () => {
      value = undefined;
    },
    filePath: () => '/tmp/aria/credentials.json',
  };
}

function fakeClient(options: {
  code?: unknown;
  poll?: LoginPollResult;
}): { client: DeviceLoginClient } {
  const client = {
    requestCode: async () =>
      options.code ?? {
        ok: true,
        value: {
          loginUrl: 'https://directioner.com/cli?code=abc',
          fingerprintHash: 'hash-1',
          expiresAt: '2026-10-11T06:10:00.000Z',
          expiresInMs: 300_000,
        },
      },
    poll: async () => options.poll ?? { status: 'timeout' },
  } as unknown as DeviceLoginClient;
  return { client };
}

describe('AccountManager', () => {
  it('restores the persisted token', () => {
    const store = fakeStore({ authToken: 'tok-9' });
    const manager = new AccountManager({ store: store as never, fingerprintId: 'fp-1' });
    expect(manager.restore()).toBe('tok-9');
  });

  it('begins a login and surfaces the URL and duration', async () => {
    const store = fakeStore();
    const { client } = fakeClient({});
    const manager = new AccountManager({ store: store as never, client, fingerprintId: 'fp-1' });
    const result = await manager.beginLogin();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.loginUrl).toBe('https://directioner.com/cli?code=abc');
    expect(result.value.expiresInMs).toBe(300_000);
  });

  it('persists the credential on a successful await', async () => {
    const store = fakeStore();
    const { client } = fakeClient({
      poll: {
        status: 'success',
        user: { authToken: 'tok-1', id: 'u1', email: 'ada@example.com', fingerprintId: 'fp-1', fingerprintHash: 'hash-1' },
      },
    });
    const manager = new AccountManager({ store: store as never, client, fingerprintId: 'fp-1' });
    await manager.beginLogin();
    const result = await manager.awaitLogin();
    expect(result.ok).toBe(true);
    expect(store.load()).toEqual({
      authToken: 'tok-1',
      id: 'u1',
      email: 'ada@example.com',
      fingerprintId: 'fp-1',
      fingerprintHash: 'hash-1',
    });
  });

  it('refuses to await when no login is pending', async () => {
    const manager = new AccountManager({ store: fakeStore() as never, fingerprintId: 'fp-1' });
    const result = await manager.awaitLogin();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('reports a timeout as a retryable failure', async () => {
    const { client } = fakeClient({ poll: { status: 'timeout' } });
    const manager = new AccountManager({ store: fakeStore() as never, client, fingerprintId: 'fp-1' });
    await manager.beginLogin();
    const result = await manager.awaitLogin();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
  });

  it('reports a cancelled login as unauthenticated', async () => {
    const { client } = fakeClient({ poll: { status: 'aborted' } });
    const manager = new AccountManager({ store: fakeStore() as never, client, fingerprintId: 'fp-1' });
    await manager.beginLogin();
    const result = await manager.awaitLogin();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unauthenticated');
  });

  it('clear forgets the credential', async () => {
    const store = fakeStore({ authToken: 'tok-9' });
    const manager = new AccountManager({ store: store as never, fingerprintId: 'fp-1' });
    manager.clear();
    expect(manager.restore()).toBeUndefined();
    expect(store.load()).toBeUndefined();
  });

  it('exposes the credential file path', () => {
    const manager = new AccountManager({ store: fakeStore() as never, fingerprintId: 'fp-1' });
    expect(manager.filePath()).toBe('/tmp/aria/credentials.json');
  });
});
