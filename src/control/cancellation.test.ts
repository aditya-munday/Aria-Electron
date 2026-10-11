import { describe, expect, it } from 'vitest';

import { InMemoryBackend } from '../backend/testing/in-memory-backend.js';
import { AriaSupervisor } from '../supervisor/supervisor.js';
import { InMemoryTaskStore } from '../supervisor/task-store.js';
import { confirmCancellation, describeCancellation, type CancellationOutcome } from './cancellation.js';

function supervisor(backend: InMemoryBackend): AriaSupervisor {
  const s = new AriaSupervisor({ client: backend, store: new InMemoryTaskStore() });
  s.start();
  return s;
}

async function running(backend: InMemoryBackend, s: AriaSupervisor): Promise<string> {
  const record = await s.submitRequest({ title: 'deploy the service' });
  const approvals = await backend.listTaskApprovals(record.taskId);
  await s.decideApproval(record.taskId, approvals.value[0]?.id as string, 'approved');
  backend.simulateStart(record.taskId);
  return record.taskId;
}

describe('AriaSupervisor.cancelAndConfirm', () => {
  it('reports confirmed only after the worker confirms the stop', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);

    const pending = s.cancelAndConfirm(taskId, { graceMs: 500, pollIntervalMs: 10 });
    setTimeout(() => backend.simulateConfirmCancellation(taskId), 30);
    const outcome = await pending;

    expect(outcome.kind).toBe('confirmed');
    expect(outcome.reason).toBe('confirmed');
    expect(outcome.observedExecutionState).toBe('cancelled');
    expect(outcome.observedCancellation).toBe('confirmed');
  });

  it('reports failure with a reason when the agent does not stop in the grace period', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);

    const outcome = await s.cancelAndConfirm(taskId, { graceMs: 40, pollIntervalMs: 10 });

    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toBe('grace_elapsed');
    expect(outcome.observedExecutionState).toBe('running');
  });

  it('never reports a false cancelled for a task that already completed', async () => {
    const backend = new InMemoryBackend();
    const s = supervisor(backend);
    const taskId = await running(backend, s);
    backend.simulateComplete(taskId, 'succeeded', 'confirmed');

    const outcome = await s.cancelAndConfirm(taskId, { graceMs: 40, pollIntervalMs: 10 });

    expect(outcome.kind).toBe('not_cancellable');
    expect(outcome.reason).toBe('execution_already_terminated');
  });
});

describe('confirmCancellation reconciliation', () => {
  const cancelledRecord = {
    taskId: 't1',
    title: 'x',
    status: 'cancelled' as const,
    version: 1,
    origin: 'aria' as const,
    executionState: 'cancelled' as const,
    cancellation: 'confirmed' as const,
    verification: 'unverified' as const,
    lastSequence: 0,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('does not advance the clock when the stop is already observed', async () => {
    let sleeps = 0;
    const outcome = await confirmCancellation(
      't1',
      {
        requestCancellation: async () => ({ ok: true }),
        observe: async () => cancelledRecord,
        sleep: async () => {
          sleeps += 1;
        },
        now: () => 0,
      },
      { graceMs: 1000, pollIntervalMs: 1 },
    );
    expect(outcome.kind).toBe('confirmed');
    expect(sleeps).toBe(0);
  });

  it('treats an undeliverable request past the deadline as a failure, not a stop', async () => {
    const outcome = await confirmCancellation(
      't1',
      {
        requestCancellation: async () => ({ ok: false }),
        observe: async () => ({ ...cancelledRecord, status: 'running', executionState: 'running', cancellation: 'none' }),
        sleep: async () => undefined,
        now: (() => {
          let t = 0;
          return () => (t += 500);
        })(),
      },
      { graceMs: 100, pollIntervalMs: 1 },
    );
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toBe('backend_unavailable');
  });

  it('describes each outcome honestly', () => {
    const confirmed: CancellationOutcome = {
      kind: 'confirmed',
      taskId: 't1',
      reason: 'confirmed',
      detail: 'The worker confirmed the stop.',
    };
    const failed: CancellationOutcome = {
      kind: 'failed',
      taskId: 't1',
      reason: 'grace_elapsed',
      detail: 'The worker did not stop within the 10000 ms grace period.',
    };
    const notCancellable: CancellationOutcome = {
      kind: 'not_cancellable',
      taskId: 't1',
      reason: 'execution_already_terminated',
      detail: "The work already reached 'completed' and could not be stopped.",
    };
    expect(describeCancellation(confirmed)).toContain('confirmed the stop');
    expect(describeCancellation(failed)).toContain('Cancellation failed');
    expect(describeCancellation(notCancellable)).toContain('Not cancelled');
  });
});
