import { describe, expect, it } from 'vitest';

import { FetchTransport, TransportFailure } from './transport.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('FetchTransport', () => {
  it('sends a bearer token and parses a JSON body', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const transport = new FetchTransport({
      baseUrl: 'https://api.test/',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>)['authorization'] as string;
        return jsonResponse(200, { identity: { userId: 'u1', roles: [], anonymous: false } });
      }) as unknown as typeof fetch,
    });
    const res = await transport.request({ method: 'GET', path: '/api/v1/me', token: 'tok' });
    expect(seenUrl).toBe('https://api.test/api/v1/me');
    expect(seenAuth).toBe('Bearer tok');
    expect(res.status).toBe(200);
  });

  it('surfaces Retry-After in seconds', async () => {
    const transport = new FetchTransport({
      baseUrl: 'https://api.test',
      fetchImpl: (async () =>
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }, {
          'retry-after': '3',
        })) as unknown as typeof fetch,
    });
    const res = await transport.request({ method: 'GET', path: '/api/v1/tasks', token: 'tok' });
    expect(res.retryAfterSecs).toBe(3);
  });

  it('treats a thrown fetch as a transport failure (uncertain outcome)', async () => {
    const transport = new FetchTransport({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(
      transport.request({ method: 'POST', path: '/api/v1/tasks', token: 'tok', body: {} }),
    ).rejects.toBeInstanceOf(TransportFailure);
  });

  it('does not throw on a non-JSON body', async () => {
    const transport = new FetchTransport({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch,
    });
    const res = await transport.request({ method: 'GET', path: '/api/v1/me', token: 'tok' });
    expect(res.status).toBe(502);
    expect(res.body).toBeUndefined();
  });
});
