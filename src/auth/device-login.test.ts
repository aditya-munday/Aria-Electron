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

  it('surfaces a 503 deployment gap verbatim, with its request id', async () => {
    const fetchImpl = vi.fn(async () =>
      json(503, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Device sign-in is not available: CLI_AUTH_HMAC_SECRET is not set.',
          requestId: 'req-1',
        },
      }),
    ) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sign_in_unavailable');
    expect(result.error.message).toBe(
      'Device sign-in is not available: CLI_AUTH_HMAC_SECRET is not set.',
    );
    expect(result.error.requestId).toBe('req-1');
    expect(result.error.status).toBe(503);
  });

  it('classifies a 410 as an expired code', async () => {
    const fetchImpl = vi.fn(async () => json(410, { error: { code: 'GONE' } })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('expired_code');
  });

  it('normalises a numeric expiresAt to an ISO string', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        loginUrl: 'https://directioner.com/cli?code=abc',
        fingerprintHash: 'h',
        expiresAt: Date.parse('2026-10-11T06:10:00.000Z'),
      }),
    ) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.requestCode('fp-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt).toBe('2026-10-11T06:10:00.000Z');
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

  it('keeps polling while the status endpoint returns { user: null }', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return json(200, { user: null });
      return json(200, { user: { authToken: 'tok-2' } });
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({ ...base, sleep: async () => undefined });
    expect(result.status).toBe('success');
    expect(calls).toBe(3);
  });

  it('stops immediately as expired on a 410', async () => {
    const fetchImpl = vi.fn(async () => json(410, { error: { code: 'GONE' } })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({ ...base, sleep: async () => undefined });
    expect(result).toEqual({ status: 'expired' });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('stops immediately as unavailable on a 503, keeping the message', async () => {
    const fetchImpl = vi.fn(async () =>
      json(503, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Device sign-in is not available: CLI_AUTH_HMAC_SECRET is not set.',
          requestId: 'req-9',
        },
      }),
    ) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({ ...base, sleep: async () => undefined });
    expect(result).toEqual({
      status: 'unavailable',
      message: 'Device sign-in is not available: CLI_AUTH_HMAC_SECRET is not set.',
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('backs off on 429 and resumes once the endpoint recovers', async () => {
    const sleeps: number[] = [];
    const limited: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      }
      if (calls === 2) return json(429, { error: { code: 'RATE_LIMITED' } });
      return json(200, { user: { authToken: 'tok-3' } });
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({
      ...base,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: () => 0,
      onRateLimited: (ms) => limited.push(ms),
    });
    expect(result.status).toBe('success');
    expect(limited).toHaveLength(2);
    // The first wait honours Retry-After (2s); the second doubles the 1s base.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('gives up with rate_limited once the back-off budget is exhausted', async () => {
    const fetchImpl = vi.fn(async () => json(429, { error: { code: 'RATE_LIMITED' } })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.poll({
      ...base,
      sleep: async () => undefined,
      jitter: () => 0,
      maxRateLimitWaitMs: 500,
    });
    expect(result.status).toBe('rate_limited');
    if (result.status !== 'rate_limited') return;
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('DeviceLoginClient.logout', () => {
  it('posts the fingerprint to the logout endpoint', async () => {
    const fetchImpl = vi.fn(async () => json(200, { success: true })) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.logout({ fingerprintId: 'fp-1', fingerprintHash: 'hash-1' });
    expect(result.ok).toBe(true);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://directioner.com/api/auth/cli/logout');
    expect(JSON.parse(call[1].body as string)).toEqual({
      fingerprintId: 'fp-1',
      fingerprintHash: 'hash-1',
    });
  });

  it('reports a transport failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new DeviceLoginClient({ baseUrl: 'https://directioner.com', fetchImpl });
    const result = await client.logout({ fingerprintId: 'fp-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('transport');
  });
});
