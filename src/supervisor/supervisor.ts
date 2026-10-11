/**
 * The Aria task supervisor.
 *
 * It owns local supervision independently of any UI window: it submits a user's
 * request through the Backend orchestration boundary, tracks the resulting task
 * and its AI-Engineer work, folds progress/questions/plan/permission signals,
 * coordinates the user's responses, requests cancellation, and reconciles state
 * after an interruption or restart.
 *
 * It is deliberately not tied to Electron. A window may open, close, or crash;
 * the supervisor and the durable store keep task state coherent regardless.
 *
 * The rules it enforces, all of which exist because getting them wrong means
 * lying to the user:
 *   - A submitted request is not an accepted task; acceptance is the Backend's
 *     task object, and running is a separate execution state.
 *   - A dispatch acknowledgement is not execution, and execution is not a result.
 *   - A cancellation request is not a confirmed stop.
 *   - Completion is not success unless `verification` is `confirmed`.
 *   - An unknown outcome stays unknown until reconciled; it is never retried
 *     blindly.
 *   - A failure in the orchestration connection never becomes a privileged local
 *     fallback.
 */

import type {
  ApprovalDto,
  CancellationState,
  Identity,
  TaskDto,
  TaskEventDto,
  TaskExecutionDto,
  TaskStatus,
  VerificationState,
} from '../contract/product-contract.js';
import { isTerminalExecutionState, isTerminalTaskStatus } from '../contract/product-contract.js';
import type { TaskApi } from '../backend/task-api.js';
import type { Result } from '../backend/result.js';
import {
  availabilityFromOutcome,
  classifyBackendOutcome,
  type BackendAvailabilityState,
  type BackendOutcome,
} from '../backend/backend-outcome.js';
import {
  confirmCancellation,
  type CancellationOutcome,
  type ConfirmCancellationOptions,
} from '../control/cancellation.js';
import {
  answerQuestionEvent,
  classifyEngineerEvent,
  permissionDecisionEvent,
  planDecisionEvent,
  type PermissionRequest,
  type PlanProposal,
  type QuestionRequest,
} from './engineer-events.js';
import type { SupervisionRecord, TaskStore } from './task-store.js';

export interface SubmitRequestInput {
  readonly title: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
}

/**
 * A coarse, user-facing phase derived from the authoritative task + execution
 * state. It keeps the distinctions the user must be able to trust: accepted vs
 * running vs verified, and cancellation requested vs confirmed.
 */
export type TaskPhase =
  | 'not_started'
  | 'accepted'
  | 'running'
  | 'completed_verified'
  | 'completed_unverified'
  | 'failed'
  | 'cancelled_confirmed'
  | 'cancellation_unconfirmed'
  | 'unknown';

export interface SupervisorDeps {
  readonly client: TaskApi;
  readonly store: TaskStore;
  readonly now?: () => string;
}

export interface EmergencyStopReport {
  /** Tasks whose cancellation was confirmed by the worker. */
  readonly stopped: readonly string[];
  /** Tasks a cancellation was requested for but not yet confirmed. */
  readonly cancellationUnconfirmed: readonly string[];
  /** Tasks whose outcome is unknown and needs reconciliation. */
  readonly unknown: readonly string[];
  /** The emergency stop is now engaged; no new work will be started. */
  readonly engaged: boolean;
}

export class AriaSupervisor {
  private readonly client: TaskApi;
  private readonly store: TaskStore;
  private readonly now: () => string;
  private emergencyStop = false;
  private availability: BackendAvailabilityState = 'unknown';
  private lastOutcome: BackendOutcome | undefined;

  constructor(deps: SupervisorDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Load persisted supervision state (call once at startup). */
  start(): void {
    this.store.load();
  }

  /** Whether emergency stop is engaged (no new work may start). */
  isEmergencyStopEngaged(): boolean {
    return this.emergencyStop;
  }

  /**
   * Engage emergency stop. It stops scheduling new work immediately and then
   * best-effort requests cancellation of running tasks through the supported
   * contract. It never fabricates a stop: a task appears in `stopped` only when
   * the Backend reports the cancellation confirmed.
   */
  async emergencyStopNow(): Promise<EmergencyStopReport> {
    this.emergencyStop = true;
    const report = await this.cancelActiveTasks();
    return { ...report, engaged: true };
  }

  /** Release emergency stop so new work may be submitted again. */
  releaseEmergencyStop(): void {
    this.emergencyStop = false;
  }

  /**
   * Submit a user's request through the Backend orchestration boundary.
   *
   * Flow: create the task, then open an approval (the authorization gate). The
   * task is now `awaiting_approval` — **accepted**, but not executing. It is not
   * dispatched until the user grants the approval, so a submitted request never
   * silently becomes running work.
   */
  async submitRequest(input: SubmitRequestInput): Promise<SupervisionRecord> {
    if (this.emergencyStop) {
      throw new SupervisorError(
        'emergency_stop',
        'Emergency stop is engaged; no new work will be started.',
      );
    }
    if (this.availability === 'offline') {
      throw new SupervisorError(
        'backend',
        'The Backend is unreachable; new tracked work is refused until it returns.',
      );
    }

    const created = await this.client.createTask({ title: input.title });
    if (!created.ok) {
      this.observeBackendOutcome(classifyBackendOutcome(created.error));
      throw new SupervisorError('backend', created.error.message, created.error);
    }
    const task = created.value;
    this.markAvailable();

    // Authorization gate: open the approval so a human decision is required
    // before any execution. The backend refuses to dispatch an unapproved task.
    const requested = await this.client.requestApproval(task.id);
    if (!requested.ok) {
      this.observeBackendOutcome(classifyBackendOutcome(requested.error));
      throw new SupervisorError('backend', requested.error.message, requested.error);
    }

    const record = this.recordFrom(requested.value.task, undefined, undefined, input);
    this.store.put(record);
    return record;
  }

  /**
   * Record the user's decision on a task's approval. On approval the task is
   * dispatched with `origin: aria`; a dispatch is an acknowledgement, not an
   * execution, so the phase becomes `accepted`, never `running`.
   */
  async decideApproval(
    taskId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<SupervisionRecord | undefined> {
    const decided = await this.client.decideApproval(approvalId, decision, reason);
    if (!decided.ok) {
      throw new SupervisorError('backend', decided.error.message, decided.error);
    }
    if (decision === 'rejected') {
      return this.refresh(taskId);
    }
    // The approval moved the task to `approved`; dispatch is now permitted.
    const dispatched = await this.client.dispatch(taskId, { origin: 'aria' });
    if (!dispatched.ok) {
      throw new SupervisorError('backend', dispatched.error.message, dispatched.error);
    }
    const record = this.recordFrom(decided.value.task, dispatched.value, this.store.get(taskId));
    this.store.put(record);
    return record;
  }

  /**
   * Dispatch an already-approved task (for a task approved out of band). A
   * dispatch is an acknowledgement; it is not evidence any work ran.
   */
  async dispatch(taskId: string): Promise<SupervisionRecord | undefined> {
    if (this.emergencyStop) {
      throw new SupervisorError(
        'emergency_stop',
        'Emergency stop is engaged; no new work will be started.',
      );
    }
    if (this.availability === 'offline') {
      throw new SupervisorError(
        'backend',
        'The Backend is unreachable; new tracked work is refused until it returns.',
      );
    }
    const dispatched = await this.client.dispatch(taskId, { origin: 'aria' });
    if (!dispatched.ok) {
      this.observeBackendOutcome(classifyBackendOutcome(dispatched.error));
      throw new SupervisorError('backend', dispatched.error.message, dispatched.error);
    }
    this.markAvailable();
    return this.refresh(taskId);
  }

  /** Re-read a task's authoritative state and fold any new journal events. */
  async refresh(taskId: string): Promise<SupervisionRecord | undefined> {
    const existing = this.store.get(taskId);
    const taskResult = await this.client.getTask(taskId);
    if (!taskResult.ok) return existing;
    const task = taskResult.value;

    const executionResult = await this.client.getExecution(taskId);
    const execution = executionResult.ok ? executionResult.value : undefined;

    const since = existing?.lastSequence ?? 0;
    const eventsResult = await this.client.listEvents(taskId, since);
    const events = eventsResult.ok ? eventsResult.value : [];

    const record = this.fold(existing, task, execution, events);
    this.store.put(record);
    return record;
  }

  /** Reconcile every tracked task; returns the refreshed records. */
  async reconcile(): Promise<readonly SupervisionRecord[]> {
    const ids = this.store.all().map((record) => record.taskId);
    const refreshed: SupervisionRecord[] = [];
    for (const id of ids) {
      const record = await this.refresh(id);
      if (record !== undefined) refreshed.push(record);
    }
    return refreshed;
  }

  backendAvailability(): BackendAvailabilityState {
    return this.availability;
  }

  lastBackendOutcome(): BackendOutcome | undefined {
    return this.lastOutcome;
  }

  canStartWork(): boolean {
    return !this.emergencyStop && this.availability !== 'offline';
  }

  async recover(): Promise<readonly SupervisionRecord[]> {
    this.store.load();
    await this.refreshAvailability();
    return this.reconcile();
  }

  async reconcileUncertain(taskId: string): Promise<SupervisionRecord | undefined> {
    return this.refresh(taskId);
  }

  async reconcileExecutions(): Promise<Result<{ readonly requeued: number }>> {
    const result = await this.client.reconcile();
    if (!result.ok) {
      this.observeBackendOutcome(classifyBackendOutcome(result.error));
      return result;
    }
    this.markAvailable();
    await this.reconcile();
    return result;
  }

  private markAvailable(): void {
    this.availability = 'online';
    this.lastOutcome = undefined;
  }

  private observeBackendOutcome(outcome: BackendOutcome): void {
    this.lastOutcome = outcome;
    this.availability = availabilityFromOutcome(outcome);
    if (this.availability === 'online') this.lastOutcome = undefined;
  }

  private async refreshAvailability(): Promise<void> {
    const probe = await this.client.getTask('__availability_probe__');
    if (probe.ok) {
      this.markAvailable();
      return;
    }
    this.observeBackendOutcome(classifyBackendOutcome(probe.error));
  }

  /** Answer AI-Engineer's question and clear it from the pending set. */
  async answerQuestion(taskId: string, questionId: string, answer: string): Promise<void> {
    const event = answerQuestionEvent(questionId, answer);
    await this.appendOrThrow(taskId, event);
    this.clearPending(taskId, (record) => ({
      ...record,
      pendingQuestions: record.pendingQuestions.filter((q) => q.questionId !== questionId),
    }));
  }

  /** Accept or reject a proposed plan and clear it from the pending set. */
  async decidePlan(
    taskId: string,
    plan: { planId: string; planVersion: number },
    decision: 'accepted' | 'rejected',
    reason?: string,
  ): Promise<void> {
    const event = planDecisionEvent(plan.planId, plan.planVersion, decision, reason);
    await this.appendOrThrow(taskId, event);
    this.clearPending(taskId, (record) => ({
      ...record,
      pendingPlans: record.pendingPlans.filter(
        (p) => !(p.planId === plan.planId && p.planVersion === plan.planVersion),
      ),
    }));
  }

  /**
   * Record the user's decision about a permission request.
   *
   * This is a metadata event to AI-Engineer, not an authorization: an actual
   * privileged operation still goes through the approval workflow and
   * Directioner-OS policy. Declining is always safe; granting here only tells
   * the engineer to *ask* the authorization system.
   */
  async decidePermission(
    taskId: string,
    requestId: string,
    decision: 'granted' | 'denied',
    reason?: string,
  ): Promise<void> {
    const event = permissionDecisionEvent(requestId, decision, reason);
    await this.appendOrThrow(taskId, event);
    this.clearPending(taskId, (record) => ({
      ...record,
      pendingPermissions: record.pendingPermissions.filter((p) => p.requestId !== requestId),
    }));
  }

  /**
   * Request cancellation of a task. Returns the refreshed record; whether the
   * stop is *confirmed* is read from `record.cancellation`, never assumed.
   */
  async cancel(taskId: string): Promise<SupervisionRecord | undefined> {
    const requested = await this.client.requestCancellation(taskId);
    if (!requested.ok) return this.store.get(taskId);
    return this.refresh(taskId);
  }

  async cancelAndConfirm(
    taskId: string,
    options: ConfirmCancellationOptions = {},
  ): Promise<CancellationOutcome> {
    const outcome = await confirmCancellation(
      taskId,
      {
        requestCancellation: async (id) => {
          const requested = await this.client.requestCancellation(id);
          return { ok: requested.ok };
        },
        observe: async (id) => this.refresh(id),
      },
      options,
    );
    return outcome;
  }

  /** Read the user-facing phase for a task. */
  phaseOf(taskId: string): TaskPhase | undefined {
    const record = this.store.get(taskId);
    return record === undefined ? undefined : describeTaskPhase(record);
  }

  /** List a task's approvals as the Backend reports them. */
  listApprovals(taskId: string): Promise<Result<readonly ApprovalDto[]>> {
    return this.client.listTaskApprovals(taskId);
  }

  /** Resolve the signed-in identity through the product client (metadata only). */
  async identity(): Promise<Result<Identity>> {
    return this.client.identity();
  }

  /** All tracked records (metadata only). */
  records(): readonly SupervisionRecord[] {
    return this.store.all();
  }

  // --- internals ----------------------------------------------------------

  private async cancelActiveTasks(): Promise<Omit<EmergencyStopReport, 'engaged'>> {
    const stopped: string[] = [];
    const cancellationUnconfirmed: string[] = [];
    const unknown: string[] = [];

    for (const record of this.store.all()) {
      if (isTerminalTaskStatus(record.status)) {
        // A terminal task is not re-cancelled, but the report still states its
        // confirmed stop (or unresolved outcome) honestly.
        if (record.cancellation === 'confirmed') stopped.push(record.taskId);
        else if (record.cancellation === 'unknown') unknown.push(record.taskId);
        continue;
      }
      if (record.executionState === undefined) continue;
      const requested = await this.client.requestCancellation(record.taskId);
      const refreshed = await this.refresh(record.taskId);
      const cancellation: CancellationState = refreshed?.cancellation ?? 'none';
      if (cancellation === 'confirmed') stopped.push(record.taskId);
      else if (cancellation === 'unknown') unknown.push(record.taskId);
      else if (requested.ok) cancellationUnconfirmed.push(record.taskId);
    }
    return { stopped, cancellationUnconfirmed, unknown };
  }

  private async appendOrThrow(
    taskId: string,
    event: { type: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    const result = await this.client.appendEvent(taskId, event);
    if (!result.ok) {
      throw new SupervisorError('backend', result.error.message, result.error);
    }
  }

  private clearPending(
    taskId: string,
    update: (record: SupervisionRecord) => SupervisionRecord,
  ): void {
    const record = this.store.get(taskId);
    if (record === undefined) return;
    this.store.put({ ...update(record), updatedAt: this.now() });
  }

  private recordFrom(
    task: TaskDto,
    execution: TaskExecutionDto | undefined,
    existing: SupervisionRecord | undefined,
    input?: SubmitRequestInput,
  ): SupervisionRecord {
    const now = this.now();
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      version: task.version,
      origin: execution?.origin ?? 'aria',
      ...(execution !== undefined ? { executionId: execution.executionId } : {}),
      ...(execution !== undefined ? { executionState: execution.state } : {}),
      ...(execution !== undefined ? { attempt: execution.attempt } : {}),
      cancellation: execution?.cancellation ?? 'none',
      verification: execution?.verification ?? 'unverified',
      ...(execution?.leaseOwner !== undefined ? { leaseOwner: execution.leaseOwner } : {}),
      lastSequence: existing?.lastSequence ?? 0,
      ...(execution?.result !== undefined
        ? { result: execution.result }
        : existing?.result !== undefined
          ? { result: existing.result }
          : {}),
      ...(existing?.progress !== undefined ? { progress: existing.progress } : {}),
      ...(input?.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : existing?.conversationId !== undefined
          ? { conversationId: existing.conversationId }
          : {}),
      ...(input?.sessionId !== undefined
        ? { sessionId: input.sessionId }
        : existing?.sessionId !== undefined
          ? { sessionId: existing.sessionId }
          : {}),
      pendingQuestions: existing?.pendingQuestions ?? [],
      pendingPermissions: existing?.pendingPermissions ?? [],
      pendingPlans: existing?.pendingPlans ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  /**
   * Fold the authoritative task + execution + new events into a record.
   *
   * Events are applied in sequence order and only forward (`sequence` above the
   * high-water mark), so a redelivered or stale event is a no-op. A terminal
   * task is sticky: a later lifecycle event cannot reopen it.
   */
  private fold(
    existing: SupervisionRecord | undefined,
    task: TaskDto,
    execution: TaskExecutionDto | undefined,
    events: readonly TaskEventDto[],
  ): SupervisionRecord {
    const base = this.recordFrom(task, execution, existing);
    let lastSequence = existing?.lastSequence ?? 0;
    let status: TaskStatus = task.status;
    let cancellation: CancellationState = execution?.cancellation ?? base.cancellation;
    let verification: VerificationState = execution?.verification ?? base.verification;

    const pendingQuestions = [...base.pendingQuestions];
    const pendingPermissions = [...base.pendingPermissions];
    const pendingPlans = [...base.pendingPlans];
    let progress = base.progress;
    let result = base.result;

    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    for (const event of ordered) {
      if (event.sequence <= lastSequence) continue; // duplicate / stale
      lastSequence = event.sequence;

      switch (event.type) {
        case 'task.started':
        case 'task.recovered':
          if (!isTerminalTaskStatus(status)) status = 'running';
          break;
        case 'task.completed':
          if (!isTerminalTaskStatus(status)) status = 'succeeded';
          result = { outcome: 'succeeded' };
          break;
        case 'task.failed':
          if (!isTerminalTaskStatus(status)) status = 'failed';
          result = { outcome: 'failed' };
          break;
        case 'task.cancelled':
          if (!isTerminalTaskStatus(status)) status = 'cancelled';
          // A confirmed cancellation event claims the stop happened.
          cancellation = 'confirmed';
          result = { outcome: 'cancelled' };
          break;
        case 'cancellation.requested':
          cancellation = cancellation === 'none' ? 'requested' : cancellation;
          break;
        case 'verification.recorded': {
          const verdict = event.payload?.['verification'];
          if (verdict === 'confirmed') verification = 'confirmed';
          else if (verdict === 'not_confirmed') verification = 'not_confirmed';
          else verification = 'inconclusive';
          break;
        }
        default: {
          const signal = classifyEngineerEvent(event);
          if (signal.kind === 'question') {
            upsert(pendingQuestions, signal, (q) => q.questionId);
          } else if (signal.kind === 'permission_requested') {
            upsert(pendingPermissions, signal, (p) => p.requestId);
          } else if (signal.kind === 'plan_proposed') {
            upsert(pendingPlans, signal, (p) => `${p.planId}:v${p.planVersion}`);
          } else if (signal.kind === 'progress') {
            progress = signal;
          }
          break;
        }
      }
    }

    // The authoritative execution state outranks the folded view.
    const executionState = execution?.state ?? base.executionState;

    return {
      ...base,
      status,
      cancellation,
      verification,
      ...(executionState !== undefined ? { executionState } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(result !== undefined ? { result } : {}),
      lastSequence,
      pendingQuestions,
      pendingPermissions,
      pendingPlans,
      updatedAt: this.now(),
    };
  }
}

function upsert<T>(list: T[], item: T, keyOf: (item: T) => string): void {
  const key = keyOf(item);
  const index = list.findIndex((existing) => keyOf(existing) === key);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

/**
 * Derive the user-facing phase. The order encodes the truth rules: a completed
 * task is only `completed_verified` when the verification is confirmed;
 * otherwise it is `completed_unverified`. A cancellation is only
 * `cancelled_confirmed` when the worker confirmed it.
 */
export function describeTaskPhase(record: SupervisionRecord): TaskPhase {
  const exec = record.executionState;
  if (exec === undefined) {
    if (record.status === 'succeeded') return 'completed_unverified';
    if (record.status === 'failed') return 'failed';
    if (record.status === 'cancelled') {
      return record.cancellation === 'confirmed' ? 'cancelled_confirmed' : 'cancellation_unconfirmed';
    }
    // The backend created the task (accepted) but no execution exists yet.
    if (
      record.status === 'draft' ||
      record.status === 'awaiting_approval' ||
      record.status === 'approved'
    ) {
      return 'accepted';
    }
    return 'not_started';
  }
  if (exec === 'pending') return 'accepted';
  if (exec === 'leased' || exec === 'running') {
    return record.cancellation === 'requested' ? 'cancellation_unconfirmed' : 'running';
  }
  if (exec === 'completed') {
    return record.verification === 'confirmed' ? 'completed_verified' : 'completed_unverified';
  }
  if (exec === 'failed') return 'failed';
  if (exec === 'cancelled') {
    return record.cancellation === 'confirmed' ? 'cancelled_confirmed' : 'cancellation_unconfirmed';
  }
  return 'unknown';
}

export class SupervisorError extends Error {
  constructor(
    readonly kind: 'backend' | 'emergency_stop',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}

/** Re-export so callers can build records without importing two modules. */
export type { SupervisionRecord };
export type { QuestionRequest, PlanProposal, PermissionRequest };
export { isTerminalExecutionState };
