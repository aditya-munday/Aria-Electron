import { describe, expect, it } from 'vitest';

import { AriaRuntime } from './runtime.js';

/**
 * An end-to-end wiring test: the real `TaskClient` and `FetchTransport` run
 * against a fake `fetch` that speaks the Backend's wire shapes. Nothing in the
 * client or supervisor is mocked.
 */
function backendFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const method = (init.method ?? 'GET') as string;
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (method === 'GET' && path === '/api/v1/me') {
      return json(200, {
        identity: { userId: 'u1', roles: ['user'], providers: ['email'], anonymous: false },
      });
    }
    if (method === 'POST' && path === '/api/v1/tasks') {
      return json(201, {
        task: {
          id: 't1',
          userId: 'u1',
          title: 'deploy',
          status: 'draft',
          version: 1,
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        },
      });
    }
    if (method === 'POST' && path === '/api/v1/approvals') {
      return json(201, {
        approval: {
          id: 'a1',
          taskId: 't1',
          userId: 'u1',
          requestedBy: 'u1',
          decision: null,
          createdAt: '2026-10-10T00:00:00.000Z',
        },
        task: {
          id: 't1',
          userId: 'u1',
          title: 'deploy',
          status: 'awaiting_approval',
          version: 2,
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        },
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } });
  }) as unknown as typeof fetch;
}

describe('AriaRuntime', () => {
  it('is not signed in until a session token is set', () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    expect(runtime.isSignedIn()).toBe(false);
    runtime.setSessionToken('tok');
    expect(runtime.isSignedIn()).toBe(true);
  });

  it('submits a request through the real client and returns an accepted task', async () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    runtime.start();
    runtime.setSessionToken('tok');
    const record = await runtime.supervisor.submitRequest({ title: 'deploy' });
    expect(record.status).toBe('awaiting_approval');
    expect(runtime.supervisor.phaseOf(record.taskId)).toBe('accepted');
  });

  it('signing out makes the next call fail as no_token, not as a backend error', async () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    runtime.start();
    await expect(runtime.supervisor.submitRequest({ title: 'deploy' })).rejects.toMatchObject({
      kind: 'backend',
      message: 'Sign in to reach the Directioner backend.',
    });
  });
});
