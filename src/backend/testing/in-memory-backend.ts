/**
 * A real, stateful implementation of the Backend's task execution boundary, for
 * tests and offline development.
 *
 * It is **not a mock**: it enforces the same lifecycle rules the Postgres
 * repository enforces (dispatch requires approval; a dispatch is not an
 * execution; a cancellation request is not a confirmed stop; a terminal state is
 * sticky; every write is idempotent by key). Driving the supervisor against it
 * exercises the supervisor's real code path.
 *
 * The `simulate*` methods stand in for the Directioner-CLI worker: they perform
 * the same contract calls a real executor would (claim, start, complete,
 * confirm cancellation, append a journal event).
 */

import { ariaError } from '../product-errors.js';
import type { Result } from '../result.js';
import { fail, ok } from '../result.js';
import type { TaskApi } from '../task-api.js';
import type {
  ApprovalDto,
  ApprovalResultEnvelope,
  Identity,
  TaskDto,
  TaskEventDto,
  TaskExecutionDto,
  TaskStatus,
} from '../../contract/product-contract.js';

export class InMemoryBackend implements TaskApi {
  private readonly tasks = new Map<string, TaskDto>();
  private readonly approvals = new Map<string, ApprovalDto>();
  private readonly executions = new Map<string, TaskExecutionDto>();
  private readonly events = new Map<string, TaskEventDto[]>();
  private readonly sequences = new Map<string, number>();
  private counter = 0;
  private clock = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(Date.UTC(2026, 9, 10) + this.clock).toISOString();
  }

  private nextSequence(taskId: string): number {
    const next = (this.sequences.get(taskId) ?? 0) + 1;
    this.sequences.set(taskId, next);
    return next;
  }

  private getTaskIn(taskId: string): TaskDto | undefined {
    return this.tasks.get(taskId);
  }

  private setTask(task: TaskDto): void {
    this.tasks.set(task.id, task);
  }

  // --- TaskApi ------------------------------------------------------------

  async identity(): Promise<Result<Identity>> {
    return ok({ userId: 'u1', email: null, roles: ['user'], providers: ['password'], anonymous: false });
  }

  async createTask(input: { title: string }): Promise<Result<TaskDto>> {
    const task: TaskDto = {
      id: this.id('t'),
      userId: 'u1',
      title: input.title,
      status: 'draft',
      version: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.setTask(task);
    return ok(task);
  }

  async getTask(taskId: string): Promise<Result<TaskDto>> {
    const task = this.getTaskIn(taskId);
    if (task === undefined) return fail(ariaError('not_found', 'Task not found.'));
    return ok(task);
  }

  async transitionTask(
    taskId: string,
    input: { status: TaskStatus; expectedVersion: number },
  ): Promise<Result<TaskDto>> {
    const task = this.getTaskIn(taskId);
    if (task === undefined) return fail(ariaError('not_found', 'Task not found.'));
    if (task.version !== input.expectedVersion) {
      return fail(ariaError('conflict', 'Task was modified by another request.'));
    }
    const next = { ...task, status: input.status, version: task.version + 1, updatedAt: this.now() };
    this.setTask(next);
    return ok(next);
  }

  async requestApproval(taskId: string): Promise<Result<ApprovalResultEnvelope>> {
    const task = this.getTaskIn(taskId);
    if (task === undefined) return fail(ariaError('not_found', 'Task not found.'));
    const approval: ApprovalDto = {
      id: this.id('a'),
      taskId,
      userId: 'u1',
      requestedBy: 'u1',
      decision: null,
      createdAt: this.now(),
    };
    this.approvals.set(approval.id, approval);
    const moved: TaskDto = {
      ...task,
      status: 'awaiting_approval',
      version: task.version + 1,
      updatedAt: this.now(),
    };
    this.setTask(moved);
    return ok({ approval, task: moved });
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<Result<ApprovalResultEnvelope>> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined) return fail(ariaError('not_found', 'Approval not found.'));
    if (approval.decision !== null) {
      return fail(ariaError('unprocessable', 'Approval has already been decided.'));
    }
    const decided: ApprovalDto = {
      ...approval,
      decision,
      decidedBy: 'u1',
      ...(reason !== undefined ? { reason } : {}),
      decidedAt: this.now(),
    };
    this.approvals.set(approvalId, decided);
    const task = this.getTaskIn(approval.taskId) as TaskDto;
    const next: TaskDto = {
      ...task,
      status: decision === 'approved' ? 'approved' : 'cancelled',
      version: task.version + 1,
      updatedAt: this.now(),
    };
    this.setTask(next);
    return ok({ approval: decided, task: next });
  }

  async listTaskApprovals(taskId: string): Promise<Result<readonly ApprovalDto[]>> {
    return ok([...this.approvals.values()].filter((a) => a.taskId === taskId));
  }

  async dispatch(taskId: string): Promise<Result<TaskExecutionDto>> {
    const task = this.getTaskIn(taskId);
    if (task === undefined) return fail(ariaError('not_found', 'Task not found.'));
    const existing = this.executions.get(taskId);
    if (existing !== undefined) return ok(existing); // idempotent per task
    if (task.status !== 'approved' && task.status !== 'running') {
      return fail(
        ariaError('unprocessable', `A task must be approved before dispatch (was ${task.status}).`),
      );
    }
    const execution: TaskExecutionDto = {
      taskId,
      userId: 'u1',
      executionId: this.id('e'),
      origin: 'aria',
      state: 'pending',
      attempt: 1,
      cancellation: 'none',
      verification: 'unverified',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.executions.set(taskId, execution);
    return ok(execution);
  }

  async getExecution(taskId: string): Promise<Result<TaskExecutionDto>> {
    const execution = this.executions.get(taskId);
    if (execution === undefined) {
      return fail(ariaError('not_found', 'Task execution not found.'));
    }
    return ok(execution);
  }

  async requestCancellation(taskId: string): Promise<Result<TaskExecutionDto>> {
    const execution = this.executions.get(taskId);
    if (execution === undefined) {
      return fail(ariaError('unprocessable', 'Task has not been dispatched.'));
    }
    if (
      execution.state === 'completed' ||
      execution.state === 'failed' ||
      execution.state === 'cancelled'
    ) {
      return fail(
        ariaError('unprocessable', `A task in state '${execution.state}' cannot be cancelled.`),
      );
    }
    if (execution.cancellation === 'requested') return ok(execution);
    const next: TaskExecutionDto = {
      ...execution,
      cancellation: 'requested',
      updatedAt: this.now(),
    };
    this.executions.set(taskId, next);
    return ok(next);
  }

  async listEvents(
    taskId: string,
    sinceSequence?: number,
  ): Promise<Result<readonly TaskEventDto[]>> {
    const all = this.events.get(taskId) ?? [];
    const filtered =
      sinceSequence === undefined ? all : all.filter((e) => e.sequence > sinceSequence);
    return ok([...filtered]);
  }

  async appendEvent(
    taskId: string,
    input: { type: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<Result<TaskEventDto>> {
    const task = this.getTaskIn(taskId);
    if (task === undefined) return fail(ariaError('not_found', 'Task not found.'));
    const existing = (this.events.get(taskId) ?? []).find(
      (e) => e.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return ok(existing); // idempotent by key
    const event: TaskEventDto = {
      id: this.id('ev'),
      taskId,
      sequence: this.nextSequence(taskId),
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdAt: this.now(),
    };
    const list = this.events.get(taskId) ?? [];
    list.push(event);
    this.events.set(taskId, list);
    return ok(event);
  }

  // --- worker simulation (stands in for the CLI executor) -----------------

  /** The worker claims the lease and starts running. */
  simulateStart(taskId: string): void {
    const execution = this.executions.get(taskId);
    if (execution === undefined) return;
    this.executions.set(taskId, { ...execution, state: 'running', updatedAt: this.now() });
    const task = this.getTaskIn(taskId);
    if (task !== undefined && task.status !== 'running') {
      this.setTask({ ...task, status: 'running', version: task.version + 1, updatedAt: this.now() });
    }
    void this.appendEvent(taskId, {
      type: 'task.started',
      idempotencyKey: `started:${execution.executionId}`,
    });
  }

  /** The worker reports the terminal outcome and verification verdict. */
  simulateComplete(
    taskId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    verification: 'confirmed' | 'not_confirmed' | 'inconclusive' = 'inconclusive',
  ): void {
    const execution = this.executions.get(taskId);
    if (execution === undefined) return;
    const state =
      outcome === 'succeeded' ? 'completed' : outcome === 'failed' ? 'failed' : 'cancelled';
    let cancellation = execution.cancellation;
    if (execution.cancellation === 'requested') {
      cancellation = outcome === 'cancelled' ? 'confirmed' : 'unknown';
    }
    this.executions.set(taskId, {
      ...execution,
      state,
      cancellation,
      verification,
      result: { outcome },
      updatedAt: this.now(),
    });
    const task = this.getTaskIn(taskId);
    if (task !== undefined) {
      const status: TaskStatus =
        outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'cancelled';
      this.setTask({ ...task, status, version: task.version + 1, updatedAt: this.now() });
    }
    void this.appendEvent(taskId, {
      type:
        outcome === 'succeeded'
          ? 'task.completed'
          : outcome === 'failed'
            ? 'task.failed'
            : 'task.cancelled',
      idempotencyKey: `result:${execution.executionId}`,
      payload: { outcome, verification },
    });
  }

  /** The worker confirms a cancellation actually stopped the work. */
  simulateConfirmCancellation(taskId: string): void {
    const execution = this.executions.get(taskId);
    if (execution === undefined) return;
    this.executions.set(taskId, {
      ...execution,
      state: 'cancelled',
      cancellation: 'confirmed',
      updatedAt: this.now(),
    });
    const task = this.getTaskIn(taskId);
    if (task !== undefined) {
      this.setTask({ ...task, status: 'cancelled', version: task.version + 1, updatedAt: this.now() });
    }
    void this.appendEvent(taskId, {
      type: 'task.cancelled',
      idempotencyKey: `cancel-confirmed:${execution.executionId}`,
    });
  }

  /** The worker appends a journal event (e.g. an `engineer.*` signal). */
  simulateWorkerEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    void this.appendEvent(taskId, {
      type,
      idempotencyKey: `${type}:${this.counter + 1}`,
      payload,
    });
  }
}
