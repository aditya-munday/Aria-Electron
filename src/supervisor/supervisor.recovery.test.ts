import { describe, expect, it } from 'vitest';

import { ariaError } from '../backend/product-errors.js';
import { fail, type Result } from '../backend/result.js';
import type { TaskApi } from '../backend/task-api.js';
import { InMemoryBackend } from '../backend/testing/in-memory-backend.js';
import { AriaSupervisor, SupervisorError } from './supervisor.js';
import { FileTaskStore, InMemoryTaskStore } from './task-store.js';
import type {
  ApprovalDto,
  ApprovalResultEnvelope,
  Identity,
  ReconcileResult,
  TaskDto,
  TaskEventDto,
  TaskExecutionDto,
  TaskStatus,
} from '../contract/product-contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FlakyBackend implements TaskApi {
  down = false;
  readonly inner = new InMemoryBackend();

  private guard<T>(): Result<T> | undefined {
    return this.down ? fail(ariaError('unavailable', 'The backend is unreachable.')) : undefined;
  }

  identity(): Promise<Result<Identity>> {
    return this.inner.identity();
  }
  createTask(input: { title: string }): Promise<Result<TaskDto>> {
    return Promise.resolve(this.guard<TaskDto>() ?? this.inner.createTask(input));
  }
  getTask(taskId: string): Promise<Result<TaskDto>> {
    return Promise.resolve(this.guard<TaskDto>() ?? this.inner.getTask(taskId));
  }
  transitionTask(taskId: string, input: { status: TaskStatus; expectedVersion: number }): Promise<Result<TaskDto>> {
    return Promise.resolve(this.guard<TaskDto>() ?? this.inner.transitionTask(taskId, input));
  }
  requestApproval(taskId: string): Promise<Result<ApprovalResultEnvelope>> {
    return Promise.resolve(this.guard<ApprovalResultEnvelope>() ?? this.inner.requestApproval(taskId));
  }
  decideApproval(approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<Result<ApprovalResultEnvelope>> {
    return Promise.resolve(this.guard<ApprovalResultEnvelope>() ?? this.inner.decideApproval(approvalId, decision, reason));
  }
  listTaskApprovals(taskId: string): Promise<Result<readonly ApprovalDto[]>> {
    return Promise.resolve(this.guard<readonly ApprovalDto[]>() ?? this.inner.listTaskApprovals(taskId));
  }
  dispatch(taskId: string): Promise<Result<TaskExecutionDto>> {
    return Promise.resolve(this.guard<TaskExecutionDto>() ?? this.inner.dispatch(taskId));
  }
  getExecution(taskId: string): Promise<Result<TaskExecutionDto>> {
    return Promise.resolve(this.guard<TaskExecutionDto>() ?? this.inner.getExecution(taskId));
  }
  requestCancellation(taskId: string): Promise<Result<TaskExecutionDto>> {
    return Promise.resolve(this.guard<TaskExecutionDto>() ?? this.inner.requestCancellation(taskId));
  }
  listEvents(taskId: string, sinceSequence?: number): Promise<Result<readonly TaskEventDto[]>> {
    return Promise.resolve(this.guard<readonly TaskEventDto[]>() ?? this.inner.listEvents(taskId, sinceSequence));
  }
  appendEvent(taskId: string, input: { type: string; idempotencyKey: string; payload?: Record<string, unknown> }): Promise<Result<TaskEventDto>> {
    return Promise.resolve(this.guard<TaskEventDto>() ?? this.inner.appendEvent(taskId, input));
  }
  reconcile(): Promise<Result<ReconcileResult>> {
    return Promise.resolve(this.guard<ReconcileResult>() ?? this.inner.reconcile());
  }
}

function supervisor(client: TaskApi, store = new InMemoryTaskStore()): AriaSupervisor {
  const s = new AriaSupervisor({ client, store });
  s.start();
  return s;
}

describe('AriaSupervisor backend availability', () => {
  it('fails closed: refuses new tracked work while offline and resumes when it returns', async () => {
    const backend = new FlakyBackend();
    const s = supervisor(backend);
    expect(s.canStartWork()).toBe(true);

    backend.down = true;
    await expect(s.submitRequest({ title: 'deploy' })).rejects.toBeInstanceOf(SupervisorError);
    expect(s.backendAvailability()).toBe('offline');
    expect(s.canStartWork()).toBe(false);

    backend.down = false;
    const recovered = await s.recover();
    expect(recovered).toEqual([]);
    expect(s.backendAvailability()).toBe('online');
    const record = await s.submitRequest({ title: 'deploy' });
    expect(record.status).toBe('awaiting_approval');
  });

  it('classifies an outage as offline and a definite rejection as online', async () => {
    const backend = new FlakyBackend();
    const s = supervisor(backend);
    backend.down = true;
    await s.recover();
    expect(s.backendAvailability()).toBe('offline');
    backend.down = false;
    await s.recover();
    expect(s.backendAvailability()).toBe('online');
  });

  it('never fabricates a result when a write outcome is uncertain', async () => {
    const backend = new FlakyBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    backend.down = true;
    const after = await s.reconcileUncertain(record.taskId);
    expect(after?.taskId).toBe(record.taskId);
    expect(after?.status).toBe('awaiting_approval');
    expect(after?.result).toBeUndefined();
  });
});

describe('AriaSupervisor crash recovery', () => {
  it('reloads durable state and re-converges after a restart', async () => {
    const backend = new FlakyBackend();
    const dir = mkdtempSync(join(tmpdir(), 'aria-recovery-'));
    const path = join(dir, 'state.json');
    try {
      const first = new AriaSupervisor({ client: backend, store: new FileTaskStore(path) });
      first.start();
      const record = await first.submitRequest({ title: 'deploy' });
      const approvals = await backend.listTaskApprovals(record.taskId);
      backend.inner.simulateWorkerEvent(record.taskId, 'engineer.question', {
        questionId: 'q1',
        question: 'Which branch?',
      });
      await first.refresh(record.taskId);

      const second = new AriaSupervisor({ client: backend, store: new FileTaskStore(path) });
      const recovered = await second.recover();
      const restored = recovered.find((r) => r.taskId === record.taskId);
      expect(restored).toBeDefined();
      expect(restored?.pendingQuestions.map((q) => q.questionId)).toContain('q1');
      expect(approvals.value.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves persisted state intact when the backend is unreachable at restart', async () => {
    const backend = new FlakyBackend();
    const store = new InMemoryTaskStore();
    const first = supervisor(backend, store);
    const record = await first.submitRequest({ title: 'deploy' });

    backend.down = true;
    const second = new AriaSupervisor({ client: backend, store });
    const recovered = await second.recover();
    expect(recovered.map((r) => r.taskId)).toContain(record.taskId);
    expect(second.backendAvailability()).toBe('offline');
    expect(store.get(record.taskId)?.taskId).toBe(record.taskId);
    expect(store.get(record.taskId)?.result).toBeUndefined();
  });

  it('reconciles uncertain state by reading status, never by resubmitting', async () => {
    const backend = new FlakyBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    const before = backend.inner.getTask(record.taskId);
    const after = await s.reconcileUncertain(record.taskId);
    const still = await backend.inner.getTask(record.taskId);
    expect(after?.taskId).toBe(record.taskId);
    expect(still.value.version).toBe((await before).value.version);
  });

  it('requeues orphaned executions through the backend reconcile endpoint', async () => {
    const backend = new FlakyBackend();
    const s = supervisor(backend);
    const record = await s.submitRequest({ title: 'deploy' });
    const approvals = await backend.listTaskApprovals(record.taskId);
    await s.decideApproval(record.taskId, approvals.value[0]?.id as string, 'approved');
    backend.inner.simulateStart(record.taskId);

    const result = await s.reconcileExecutions();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.requeued).toBe(1);
  });
});
