import { describe, expect, it } from 'vitest';

import { TaskClient } from './task-client.js';
import { InMemoryTransport, SharedToken, NoToken } from './transport.js';

function client(
  transport: InMemoryTransport,
  token: SharedToken | NoToken = new SharedToken('tok'),
): TaskClient {
  return new TaskClient({ transport, tokens: token, backoffMs: 0 });
}

const TASK = {
  id: 't1',
  userId: 'u1',
  title: 'deploy',
  status: 'draft',
  version: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};

const EXECUTION = {
  taskId: 't1',
  userId: 'u1',
  executionId: 'e1',
  origin: 'aria',
  state: 'pending',
  attempt: 1,
  cancellation: 'none',
  verification: 'unverified',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};

describe('TaskClient identity', () => {
  it('reads the authenticated principal from the token, never the request', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/api/v1/me',
      status: 200,
      body: {
        identity: {
          userId: 'u1',
          email: 'a@example.com',
          roles: ['user'],
          providers: ['email'],
          anonymous: false,
        },
      },
    });
    const result = await client(t).identity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.userId).toBe('u1');
    expect(t.recorded()[0]).toEqual({ method: 'GET', path: '/api/v1/me' });
  });

  it('reports no_token before any request when signed out', async () => {
    const t = new InMemoryTransport();
    const result = await client(t, new NoToken()).listTasks(20);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_token');
    expect(t.recorded()).toHaveLength(0);
  });
});

describe('TaskClient tasks and dispatch', () => {
  it('creates a task and returns the backend object', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks',
      status: 201,
      body: { task: TASK },
    });
    const result = await client(t).createTask({ title: 'deploy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('t1');
    expect(t.recorded()[0]?.body).toEqual({ title: 'deploy' });
  });

  it('dispatch returns pending — an acknowledgement, not an execution', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks/t1/dispatch',
      status: 201,
      body: { execution: EXECUTION },
    });
    const result = await client(t).dispatch('t1', { origin: 'aria' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('pending');
    expect(result.value.origin).toBe('aria');
    expect(t.recorded()[0]?.body).toEqual({ origin: 'aria' });
  });

  it('a cancellation request is recorded but not a confirmed stop', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks/t1/cancel',
      status: 200,
      body: { execution: { ...EXECUTION, state: 'running', cancellation: 'requested' } },
    });
    const result = await client(t).requestCancellation('t1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancellation).toBe('requested');
  });
});

describe('TaskClient retry policy', () => {
  it('retries a transient read and honours Retry-After', async () => {
    const t = new InMemoryTransport()
      .on({
        method: 'GET',
        path: '/api/v1/tasks?limit=20',
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        retryAfterSecs: 0,
      })
      .on({
        method: 'GET',
        path: '/api/v1/tasks?limit=20',
        status: 200,
        body: { items: [] },
      });
    const result = await client(t).listTasks(20);
    expect(result.ok).toBe(true);
    expect(t.recorded()).toHaveLength(2);
  });

  it('never auto-retries a mutating write (an uncertain outcome)', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks',
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom' } },
    });
    const result = await client(t).createTask({ title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unavailable');
    // Exactly one attempt: repeating could double-create the task.
    expect(t.recorded()).toHaveLength(1);
  });

  it('classifies a transport failure as an uncertain outcome', async () => {
    const t = new InMemoryTransport().failAll('connection reset');
    const result = await client(t).createTask({ title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('transport');
  });
});

describe('TaskClient validation and redaction', () => {
  it('treats a malformed success body as an error, not a task', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks',
      status: 201,
      body: { task: { nope: true } },
    });
    const result = await client(t).createTask({ title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed');
  });

  it('redacts credential-shaped text from an error message', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/api/v1/tasks',
      status: 400,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'bad token=supersecretvalue' },
      },
    });
    const result = await client(t).createTask({ title: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('supersecretvalue');
    expect(result.error.message).toContain('[redacted]');
  });
});
