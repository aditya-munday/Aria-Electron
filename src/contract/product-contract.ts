/**
 * Aria's view of the Directioner Platform Backend **product** surface
 * (`/api/v1`): identity, tasks, approvals, and the execution/dispatch boundary.
 *
 * This is a mirror of the backend's own contract, not a definition. The source
 * of truth is the backend (`src/modules/execution/execution.ts`,
 * `src/http/routes/workload.ts`, `src/modules/database/repositories/*`) and the
 * prose contract `docs/TASK-EXECUTION-CONTRACT.md`. If a field here disagrees
 * with the backend, the backend wins and this file is wrong.
 *
 * Aria's speech surface (`/v1`) is a *different* contract with its own error
 * envelope; it lives in `./aria-contract.ts`. The two share a bearer token but
 * not a wire shape, so they are kept apart deliberately.
 *
 * The load-bearing rules, restated because a client that gets them wrong lies to
 * the user:
 *   1. A dispatch is not an execution, and an execution is not a result.
 *   2. A cancellation *request* is not a confirmed stop.
 *   3. An acknowledgement (an `approval.*` event) is not a result.
 *   4. Absence of evidence is not success: only `verification: confirmed` proves
 *      an effect.
 *   5. Identity comes from the token; no method accepts a `userId`.
 */

/** The product-surface path prefix. */
export const PRODUCT_PREFIX = '/api/v1' as const;

/** Product-surface paths, mirroring the backend's registered routes. */
export const productPaths = {
  me: '/api/v1/me',
  session: '/api/v1/session',
  logout: '/api/v1/logout',
  tasks: '/api/v1/tasks',
  task: (taskId: string) => `/api/v1/tasks/${encodeURIComponent(taskId)}`,
  taskTransitions: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/transitions`,
  taskApprovals: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/approvals`,
  approvals: '/api/v1/approvals',
  approval: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}`,
  approvalDecision: (approvalId: string) =>
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
  taskDispatch: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/dispatch`,
  taskExecution: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/execution`,
  taskEvents: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/events`,
  taskCancel: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
  taskExecutionClaim: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/claim`,
  taskExecutionHeartbeat: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/heartbeat`,
  taskExecutionResult: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/result`,
  taskExecutionCancellation: (taskId: string) =>
    `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/cancellation`,
  runnable: '/api/v1/executions/runnable',
  reconcile: '/api/v1/executions/reconcile',
} as const;

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export interface TaskDto {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The envelope the backend wraps a single task in. */
export interface TaskEnvelope {
  readonly task: TaskDto;
}

/** The paginated list envelope (`{ items, nextCursor }`). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | null;
}

// ---------------------------------------------------------------------------
// Execution / dispatch
// ---------------------------------------------------------------------------

export type ExecutionState =
  | 'pending'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.has(state);
}

export type CancellationState =
  | 'none'
  | 'requested'
  | 'confirmed'
  | 'unknown'
  | 'failed';

export type VerificationState =
  | 'unverified'
  | 'confirmed'
  | 'not_confirmed'
  | 'inconclusive';

export type ExecutionOrigin = 'cli' | 'website' | 'aria' | 'desktop' | 'gui';

export interface ExecutionResultDto {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly summary?: string;
  readonly artifactRefs?: readonly string[];
  readonly errorCode?: string;
}

export interface TaskExecutionDto {
  readonly taskId: string;
  readonly userId: string;
  /** Stable execution identity, distinct from the task id. */
  readonly executionId: string;
  readonly origin: ExecutionOrigin;
  readonly state: ExecutionState;
  readonly attempt: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly cancellation: CancellationState;
  readonly result?: ExecutionResultDto;
  readonly verification: VerificationState;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecutionEnvelope {
  readonly execution: TaskExecutionDto;
}

export interface ClaimResult {
  readonly execution: TaskExecutionDto;
  readonly claimed: boolean;
  readonly reason?: 'terminal' | 'not_dispatched' | 'lease_held';
}

export interface ReconcileResult {
  readonly requeued: number;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalDecisionValue = 'approved' | 'rejected';

export interface ApprovalDto {
  readonly id: string;
  readonly taskId: string;
  readonly userId: string;
  readonly requestedBy: string;
  readonly decision: ApprovalDecisionValue | null;
  readonly decidedBy?: string | null;
  readonly reason?: string | null;
  readonly createdAt: string;
  readonly decidedAt?: string | null;
}

export interface ApprovalResultEnvelope {
  readonly approval: ApprovalDto;
  readonly task: TaskDto;
}

export interface ApprovalsEnvelope {
  readonly approvals: readonly ApprovalDto[];
}

export function isApprovalPending(approval: ApprovalDto): boolean {
  return approval.decision === null;
}

// ---------------------------------------------------------------------------
// Journal events
// ---------------------------------------------------------------------------

/**
 * The event vocabulary the backend accepts. The set is not closed on the wire
 * (`type` is a free string), but a client must only emit types it understands.
 * The `task.*`/`cancellation.*`/`approval.*`/`tool.*`/`verification.*`/
 * `security.*` tokens are the lifecycle and metadata events; the
 * `engineer.*` tokens are the AI-Engineer communication events (progress,
 * questions, plan changes, permission requests). All of the latter are
 * metadata: none has lifecycle authority.
 */
export type TaskEventType =
  | 'task.created'
  | 'task.started'
  | 'task.recovered'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'cancellation.requested'
  | 'tool.completed'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'verification.recorded'
  | 'security.event'
  | 'engineer.progress'
  | 'engineer.question'
  | 'engineer.plan_proposed'
  | 'engineer.permission_requested';

export interface TaskEventDto {
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly payload?: Record<string, unknown>;
  readonly createdAt: string;
}

export interface TaskEventEnvelope {
  readonly event: TaskEventDto;
}

export interface TaskEventsEnvelope {
  readonly events: readonly TaskEventDto[];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface Identity {
  readonly userId: string;
  readonly email?: string | null;
  readonly roles: readonly string[];
  readonly providers: readonly string[];
  readonly anonymous: boolean;
}

export interface IdentityEnvelope {
  readonly identity: Identity;
}

// ---------------------------------------------------------------------------
// Product-surface error body (`{ error: { code, message, ... } }`)
// ---------------------------------------------------------------------------

export interface ProductErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly details?: readonly { path: string; message: string }[];
}

export interface ProductErrorBody {
  readonly error: ProductErrorDetail;
}
