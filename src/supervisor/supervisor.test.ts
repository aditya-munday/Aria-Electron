import { describe, expect, it } from 'vitest';

import { InMemoryBackend } from '../backend/testing/in-memory-backend.js';
import { AriaSupervisor, describeTaskPhase, SupervisorError } from './supervisor.js';
import { FileTaskStore, InMemoryTaskStore } from './task-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

function supervisor(backend: InMemoryBackend): AriaSupervisor {
  const s = new AriaSupervisor({ client: backend, store: new InMemoryTaskStore() });
  s.start();
  return s;
}

/** Submit a request and drive it to a running task owned by the worker. */
async function running(
  backend: InMemoryBackend,
  s: AriaSupervisor,
): Promise<string> {
  const record = await s.submitRequest({ title: 'deploy the service' });
  const approvals = await backend.listTaskApprovals(record.taskId);
  const approvalId = approvals.value[0]?.id as string;
  await s.decideApproval(record.taskId, approvalId, 'approved');
  backend.simulateStart(record.taskId);
  return record.taskId;
}

describe('AriaSupervisor orchestration', () => {
  it('submits a request as an accepted task, not a running one', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    expect(record.status).toBe('awaiting_approval');
    expect(s.phaseOf(record.taskId)).toBe('accepted');
  });

  it('does not dispatch an unapproved task (the authorization gate holds)', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    const result = await backend.dispatch(record.taskId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unprocessable');
  });

  it('dispatches after approval and reports accepted (not running)', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    const approvals = await backend.listTaskApprovals(record.taskId);
    const approvalId = approvals.value[0]?.id as string;
    const after = await s.decideApproval(record.taskId, approvalId, 'approved');
    expect(after?.executionState).toBe('pending');
    expect(s.phaseOf(record.taskId)).toBe('accepted');
  });

  it('reports running after the worker starts', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    await s.refresh(taskId);
    expect(s.phaseOf(taskId)).toBe('running');
  });
});

describe('AriaSupervisor engineer communication', () => {
  it('surfaces progress, questions, plan proposals and permission requests', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);

    backend.simulateWorkerEvent(taskId, 'engineer.progress', { summary: 'planning', percent: 10 });
    backend.simulateWorkerEvent(taskId, 'engineer.question', {
      questionId: 'q1',
      question: 'Which branch?',
      options: ['main', 'dev'],
    });
    backend.simulateWorkerEvent(taskId, 'engineer.plan_proposed', {
      planId: 'p1',
      planVersion: 1,
      summary: 'install jq',
      operations: [{ capability: 'package.install' }],
    });
    backend.simulateWorkerEvent(taskId, 'engineer.permission_requested', {
      requestId: 'r1',
      capability: 'network.configure',
      scope: 'wlan0',
    });

    const record = await s.refresh(taskId);
    expect(record?.pendingQuestions.map((q) => q.questionId)).toEqual(['q1']);
    expect(record?.pendingPlans.map((p) => p.planId)).toEqual(['p1']);
    expect(record?.pendingPermissions.map((p) => p.requestId)).toEqual(['r1']);
  });

  it('clears a question once the user answers it', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    backend.simulateWorkerEvent(taskId, 'engineer.question', {
      questionId: 'q1',
      question: 'Which branch?',
    });
    await s.refresh(taskId);
    await s.answerQuestion(taskId, 'q1', 'main');
    const record = await s.refresh(taskId);
    expect(record?.pendingQuestions).toHaveLength(0);
    // The answer was appended to the journal.
    const events = await backend.listEvents(taskId);
    expect(events.value.some((e) => e.type === 'engineer.answer')).toBe(true);
  });
});

describe('AriaSupervisor completion and verification', () => {
  it('a completed-but-unverified task is not reported as verified', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    backend.simulateComplete(taskId, 'succeeded', 'inconclusive');
    await s.refresh(taskId);
    expect(s.phaseOf(taskId)).toBe('completed_unverified');
  });

  it('a completed-and-confirmed task is reported as verified', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    backend.simulateComplete(taskId, 'succeeded', 'confirmed');
    await s.refresh(taskId);
    expect(s.phaseOf(taskId)).toBe('completed_verified');
  });
});

describe('AriaSupervisor cancellation', () => {
  it('a cancellation request is not a confirmed stop', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    await s.cancel(taskId);
    expect(s.phaseOf(taskId)).toBe('cancellation_unconfirmed');
  });

  it('a worker-confirmed cancellation is reported as confirmed', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    await s.cancel(taskId);
    backend.simulateConfirmCancellation(taskId);
    await s.refresh(taskId);
    expect(s.phaseOf(taskId)).toBe('cancelled_confirmed');
  });

  it('a completion that beats a cancellation is unknown, never cancelled', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    await s.cancel(taskId);
    backend.simulateComplete(taskId, 'succeeded', 'confirmed');
    const record = await s.refresh(taskId);
    expect(record?.cancellation).toBe('unknown');
    expect(s.phaseOf(taskId)).toBe('completed_verified');
  });
});

describe('AriaSupervisor emergency stop', () => {
  it('engages, requests cancellation, and reports the honest outcome', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    const report = await s.emergencyStopNow();
    expect(report.engaged).toBe(true);
    // The stop is requested, not yet confirmed.
    expect(report.cancellationUnconfirmed).toContain(taskId);
    expect(report.stopped).toHaveLength(0);
  });

  it('refuses to start new work while engaged', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    await s.emergencyStopNow();
    await expect(s.submitRequest({ title: 'another' })).rejects.toBeInstanceOf(SupervisorError);
  });

  it('reports a confirmed stop only after the worker confirms it', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    await s.cancel(taskId);
    backend.simulateConfirmCancellation(taskId);
    await s.refresh(taskId);
    const report = await s.emergencyStopNow();
    expect(report.stopped).toContain(taskId);
  });
});

describe('AriaSupervisor durable supervision', () => {
  it('survives a restart: state is restored and a duplicate event is idempotent', async () => {
    const backend = new InMemoryBackend();
    const dir = mkdtempSync(join(tmpdir(), 'aria-supervisor-'));
    const path = join(dir, 'state.json');
    try {
      const store = new FileTaskStore(path);
      const first = new AriaSupervisor({ client: backend, store });
      first.start();
      const record = await first.submitRequest({ title: 'deploy' });
      const taskId = record.taskId;

      // A new supervisor instance loads the persisted state.
      const store2 = new FileTaskStore(path);
      const second = new AriaSupervisor({ client: backend, store: store2 });
      second.start();
      expect(second.records().map((r) => r.taskId)).toContain(taskId);

      // A redelivered event does not change the folded state.
      const before = second.records()[0];
      await second.refresh(taskId);
      await second.refresh(taskId);
      const after = second.records()[0];
      expect(after?.lastSequence).toBe(before?.lastSequence);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reopens a terminal task from a late lifecycle event', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    backend.simulateComplete(taskId, 'succeeded', 'confirmed');
    await s.refresh(taskId);
    // A stale 'task.started' appended after completion must not reopen it.
    backend.simulateWorkerEvent(taskId, 'task.started', {});
    const record = await s.refresh(taskId);
    expect(record?.status).toBe('succeeded');
  });
});

describe('describeTaskPhase truth table', () => {
  const base = {
    taskId: 't1',
    title: 'x',
    status: 'running' as const,
    version: 1,
    origin: 'aria' as const,
    cancellation: 'none' as const,
    verification: 'unverified' as const,
    lastSequence: 0,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  it('an unknown execution state is never success', () => {
    expect(
      describeTaskPhase({ ...base, executionState: 'completed', verification: 'inconclusive' }),
    ).toBe('completed_unverified');
  });
});
