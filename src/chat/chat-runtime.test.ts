import { describe, expect, it } from 'vitest';

import { AriaRuntime } from '../runtime.js';
import { createChatRuntime } from './chat-runtime.js';

/**
 * An end-to-end wiring test for the chat runtime: the real `TaskClient`,
 * `FetchTransport` and `AriaSupervisor` run against a fake `fetch` that speaks
 * the Backend's product wire shapes. Nothing in the client or supervisor is
 * mocked, so submission really flows through the execution boundary.
 */
function productFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const method = (init.method ?? 'GET') as string;
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    const task = (status: string, version: number) => ({
      id: 't1',
      userId: 'u1',
      title: 'deploy the api',
      status,
      version,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    });

    if (method === 'POST' && path === '/api/v1/tasks') {
      return json(201, { task: task('draft', 1) });
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
        task: task('awaiting_approval', 2),
      });
    }
    if (method === 'GET' && path === '/api/v1/tasks/t1') {
      return json(200, { task: task('awaiting_approval', 2) });
    }
    if (method === 'GET' && path === '/api/v1/tasks/t1/approvals') {
      return json(200, {
        approvals: [
          {
            id: 'a1',
            taskId: 't1',
            userId: 'u1',
            requestedBy: 'u1',
            decision: null,
            createdAt: '2026-10-10T00:00:00.000Z',
          },
        ],
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } });
  }) as unknown as typeof fetch;
}

function runtime(): AriaRuntime {
  const built = new AriaRuntime({
    config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
    fetchImpl: productFetch(),
  });
  built.start();
  built.setSessionToken('tok');
  return built;
}

describe('createChatRuntime submission wiring', () => {
  it('submits a request as tracked work and returns the task and its approval', async () => {
    const chat = createChatRuntime(runtime());
    const submitted = await chat.tasks.submit({ title: 'deploy the api' });
    expect(submitted.record.taskId).toBe('t1');
    expect(submitted.record.status).toBe('awaiting_approval');
    expect(submitted.approvalId).toBe('a1');
  });

  it('exposes the approval scope it remembered for the submission', async () => {
    const chat = createChatRuntime(runtime());
    const submitted = await chat.tasks.submit({ title: 'deploy the api' });
    await chat.tasks.rememberApproval({
      approvalId: submitted.approvalId,
      taskId: submitted.record.taskId,
      planVersion: 1,
      operation: {
        capability: 'deploy.service',
        parameters: {},
        privilege: 'user',
        riskTier: 'standard',
        affectedResources: [],
      },
    });
    const scope = chat.tasks.approvalScope(submitted.approvalId);
    expect(scope?.taskId).toBe('t1');
    expect(scope?.operation.capability).toBe('deploy.service');
  });

  it('reconciles tracked tasks against the Backend without throwing', async () => {
    const chat = createChatRuntime(runtime());
    await chat.tasks.submit({ title: 'deploy the api' });
    await expect(chat.tasks.reconcile()).resolves.toBeUndefined();
    expect(chat.tasks.records()).toHaveLength(1);
  });
});
