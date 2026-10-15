import { describe, expect, it, vi } from 'vitest';

import { DeviceLoginClient } from './device-login.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CODE = {
  loginUrl: 'https://directioner.com/cli?code=abc',
  fingerprintHash: 'hash-1',
  expiresAt: '2026-10-11T06:10:00.000Z',
  expiresInMs: 300_000,
};

describe('DeviceLoginClient.requestCode', () => {
  it('defaults to the Aria backend origin for the device-code endpoints', async () => {
    const fetchImpl = vi.fn(async () => json(200, CODE)) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ fetchImpl });
    await client.requestCode('fp-1');
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.adityamunday.codes/api/auth/cli/code');
  });

  it('posts the fingerprint and echoes the server expiry verbatim', async () => {
    const fetchImpl = vi.fn(async () => json(200, CODE)) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(CODE);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://directioner.com/api/auth/cli/code');
    expect(JSON.parse(call[1].body as string)).toEqual({ fingerprintId: 'fp-1' });
  });

  it('classifies a 403 as forbidden', async () => {
    const fetchImpl = vi.fn(async () => json(403, { code: 'FORBIDDEN' })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('forbidden');
  });

  it('reports a transport failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('transport');
  });

  it('rejects a response missing the login URL', async () => {
    const fetchImpl = vi.fn(async () => json(200, { fingerprintHash: 'h', expiresAt: 'x' })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed');
  });
});

describe('DeviceLoginClient.poll', () => {
  const base = {
    fingerprintId: 'fp-1',
    fingerprintHash: 'hash-1',
    expiresAt: '2026-10-11T06:10:00.000Z',
    expiresInMs: 300_000,
  };

  it('returns the user once the status endpoint reports a token', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return json(401, { code: 'PENDING' });
      return json(200, { user: { authToken: 'tok-1', id: 'u1', email: 'ada@example.com' } });
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({ ...base, sleep: async () => undefined });
    expect(result).toEqual({
      status: 'success',
      user: {
        authToken: 'tok-1',
        id: 'u1',
        email: 'ada@example.com',
        fingerprintId: 'fp-1',
        fingerprintHash: 'hash-1',
      },
    });
    expect(calls).toBe(2);
  });

  it('stops when the injected deadline has passed', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => json(401, { code: 'PENDING' })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({
      ...base,
      sleep: async () => {
        clock += 1000;
      },
      now: () => clock,
    });
    expect(result).toEqual({ status: 'timeout' });
  });

  it('aborts when shouldContinue turns false', async () => {
    let allow = true;
    const fetchImpl = vi.fn(async () => {
      allow = false;
      return json(401, { code: 'PENDING' });
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({
      ...base,
      sleep: async () => undefined,
      shouldContinue: () => allow,
    });
    expect(result).toEqual({ status: 'aborted' });
  });
});
