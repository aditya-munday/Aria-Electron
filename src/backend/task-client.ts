/**
 * The authenticated product-surface client (`/api/v1`): tasks, approvals, the
 * execution boundary, and identity.
 *
 * It is the single supported path for Aria to submit a request to the Backend
 * and to coordinate the resulting AI-Engineer work. It speaks only the
 * Backend's own contract (see `../contract/product-contract.ts`); it does not
 * invent endpoints and it never talks to a provider or to Directioner-OS.
 *
 * Guarantees:
 *   - Identity comes from the token; no method accepts or sends a `userId`.
 *   - A dispatch is not an execution, and an execution is not a result.
 *   - Reads retry transient failures with bounded backoff; **mutating writes are
 *     never retried automatically** (a dropped connection could mean the write
 *     was applied), so an uncertain outcome is surfaced for reconciliation.
 *   - Every response is validated before it is trusted.
 */

import { z } from 'zod';

import {
  productPaths,
  type ApprovalDto,
  type ApprovalResultEnvelope,
  type ApprovalsEnvelope,
  type ClaimResult,
  type ExecutionEnvelope,
  type ExecutionOrigin,
  type Identity,
  type IdentityEnvelope,
  type Page,
  type ReconcileResult,
  type TaskDto,
  type TaskEnvelope,
  type TaskEventDto,
  type TaskEventEnvelope,
  type TaskEventsEnvelope,
  type TaskExecutionDto,
  type TaskStatus,
} from '../contract/product-contract.js';
import { ariaError, kindForStatus, isRetryableRead, type AriaBackendError } from './product-errors.js';
import { fail, ok, type Result } from './result.js';
import { TransportFailure, type TokenSource, type Transport } from './transport.js';

// ---------------------------------------------------------------------------
// Wire validation (a malformed success body is an error, never trusted)
// ---------------------------------------------------------------------------

const taskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  status: z.enum([
    'draft',
    'awaiting_approval',
    'approved',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const executionResultSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  summary: z.string().optional(),
  artifactRefs: z.array(z.string()).optional(),
  errorCode: z.string().optional(),
});

const executionSchema = z.object({
  taskId: z.string(),
  userId: z.string(),
  executionId: z.string(),
  origin: z.enum(['cli', 'website', 'aria', 'desktop', 'gui']),
  state: z.enum(['pending', 'leased', 'running', 'completed', 'failed', 'cancelled']),
  attempt: z.number(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  cancellation: z.enum(['none', 'requested', 'confirmed', 'unknown', 'failed']),
  result: executionResultSchema.optional(),
  verification: z.enum(['unverified', 'confirmed', 'not_confirmed', 'inconclusive']),
  errorCode: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const eventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sequence: z.number(),
  type: z.string(),
  idempotencyKey: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});

const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  userId: z.string(),
  requestedBy: z.string(),
  decision: z.enum(['approved', 'rejected']).nullable(),
  decidedBy: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  createdAt: z.string(),
  decidedAt: z.string().nullable().optional(),
});

const identitySchema = z.object({
  userId: z.string(),
  email: z.string().nullable().optional(),
  roles: z.array(z.string()),
  provider: z.array(z.string()).optional(),
  providers: z.array(z.string()).optional(),
  anonymous: z.boolean(),
});

const productErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  readonly title: string;
}

export interface TransitionTaskInput {
  readonly status: TaskStatus;
  readonly expectedVersion: number;
}

export interface DispatchInput {
  readonly origin?: ExecutionOrigin;
  readonly idempotencyKey?: string;
}

export interface AppendEventInput {
  readonly type: string;
  readonly idempotencyKey: string;
  readonly payload?: Record<string, unknown>;
}

export interface RecordResultInput {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly summary?: string;
  readonly artifactRefs?: readonly string[];
  readonly verification: 'confirmed' | 'not_confirmed' | 'inconclusive';
  readonly errorCode?: string;
  readonly idempotencyKey: string;
}

export interface TaskClientOptions {
  readonly transport: Transport;
  readonly tokens: TokenSource;
  /** Max automatic retries for read-only requests. Default 2. */
  readonly maxRetries?: number;
  /** Base backoff in ms between read retries. Default 20. */
  readonly backoffMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 20;

export class TaskClient {
  private readonly transport: Transport;
  private readonly tokens: TokenSource;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(options: TaskClientOptions) {
    this.transport = options.transport;
    this.tokens = options.tokens;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  // --- identity -----------------------------------------------------------

  async identity(): Promise<Result<Identity>> {
    const raw = await this.read(productPaths.me);
    if (!raw.ok) return raw;
    const parsed = identitySchema.safeParse((raw.value as { identity?: unknown }).identity);
    if (!parsed.success) return fail(malformed('identity'));
    const d = parsed.data;
    return ok({
      userId: d.userId,
      email: d.email ?? null,
      roles: d.roles,
      providers: d.providers ?? d.provider ?? [],
      anonymous: d.anonymous,
    });
  }

  // --- tasks --------------------------------------------------------------

  async listTasks(limit = 20): Promise<Result<Page<TaskDto>>> {
    const raw = await this.read(`${productPaths.tasks}?limit=${clampLimit(limit)}`);
    if (!raw.ok) return raw;
    const body = raw.value as { items?: unknown };
    const parsed = z.array(taskSchema).safeParse(body.items);
    if (!parsed.success) return fail(malformed('task list'));
    return ok({ items: parsed.data as TaskDto[] });
  }

  async getTask(taskId: string): Promise<Result<TaskDto>> {
    const raw = await this.read(productPaths.task(taskId));
    if (!raw.ok) return raw;
    const parsed = taskSchema.safeParse((raw.value as { task?: unknown }).task);
    if (!parsed.success) return fail(malformed('task'));
    return ok(parsed.data as TaskDto);
  }

  async createTask(input: CreateTaskInput): Promise<Result<TaskDto>> {
    const raw = await this.write(productPaths.tasks, { title: input.title });
    if (!raw.ok) return raw;
    const parsed = taskSchema.safeParse((raw.value as { task?: unknown }).task);
    if (!parsed.success) return fail(malformed('task'));
    return ok(parsed.data as TaskDto);
  }

  async transitionTask(
    taskId: string,
    input: TransitionTaskInput,
  ): Promise<Result<TaskDto>> {
    const raw = await this.write(productPaths.taskTransitions(taskId), {
      status: input.status,
      expectedVersion: input.expectedVersion,
    });
    if (!raw.ok) return raw;
    const parsed = taskSchema.safeParse((raw.value as { task?: unknown }).task);
    if (!parsed.success) return fail(malformed('task'));
    return ok(parsed.data as TaskDto);
  }

  // --- approvals ----------------------------------------------------------

  async requestApproval(taskId: string): Promise<Result<ApprovalResultEnvelope>> {
    const raw = await this.write(productPaths.approvals, { taskId });
    if (!raw.ok) return raw;
    return parseApprovalResult(raw.value);
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<Result<ApprovalResultEnvelope>> {
    const raw = await this.write(productPaths.approvalDecision(approvalId), {
      decision,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!raw.ok) return raw;
    return parseApprovalResult(raw.value);
  }

  async listTaskApprovals(taskId: string): Promise<Result<readonly ApprovalDto[]>> {
    const raw = await this.read(productPaths.taskApprovals(taskId));
    if (!raw.ok) return raw;
    const parsed = z
      .array(approvalSchema)
      .safeParse((raw.value as { approvals?: unknown }).approvals);
    if (!parsed.success) return fail(malformed('approvals'));
    return ok(parsed.data as ApprovalDto[]);
  }

  // --- execution boundary -------------------------------------------------

  async dispatch(taskId: string, input: DispatchInput = {}): Promise<Result<TaskExecutionDto>> {
    const raw = await this.write(productPaths.taskDispatch(taskId), {
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    if (!raw.ok) return raw;
    return parseExecution(raw.value);
  }

  async getExecution(taskId: string): Promise<Result<TaskExecutionDto>> {
    const raw = await this.read(productPaths.taskExecution(taskId));
    if (!raw.ok) return raw;
    return parseExecution(raw.value);
  }

  async requestCancellation(taskId: string): Promise<Result<TaskExecutionDto>> {
    const raw = await this.write(productPaths.taskCancel(taskId), undefined);
    if (!raw.ok) return raw;
    return parseExecution(raw.value);
  }

  async listEvents(taskId: string, sinceSequence?: number): Promise<Result<readonly TaskEventDto[]>> {
    const query =
      sinceSequence !== undefined ? `?sinceSequence=${encodeURIComponent(String(sinceSequence))}` : '';
    const raw = await this.read(`${productPaths.taskEvents(taskId)}${query}`);
    if (!raw.ok) return raw;
    const parsed = z.array(eventSchema).safeParse((raw.value as { events?: unknown }).events);
    if (!parsed.success) return fail(malformed('events'));
    return ok(parsed.data as TaskEventDto[]);
  }

  async appendEvent(
    taskId: string,
    input: AppendEventInput,
  ): Promise<Result<TaskEventDto>> {
    const raw = await this.write(productPaths.taskEvents(taskId), {
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = eventSchema.safeParse((raw.value as { event?: unknown }).event);
    if (!parsed.success) return fail(malformed('event'));
    return ok(parsed.data as TaskEventDto);
  }

  async reconcile(): Promise<Result<ReconcileResult>> {
    const raw = await this.write(productPaths.reconcile, undefined);
    if (!raw.ok) return raw;
    const parsed = z
      .object({ requeued: z.number() })
      .safeParse(raw.value);
    if (!parsed.success) return fail(malformed('reconcile'));
    return ok(parsed.data);
  }

  // --- internals ----------------------------------------------------------

  /** A read-only request: safe to retry transient failures. */
  private async read(path: string): Promise<Result<unknown>> {
    let attempt = 0;
    for (;;) {
      const result = await this.attempt('GET', path);
      if (result.ok) return result;
      if (isRetryableRead(result.error) && attempt < this.maxRetries) {
        attempt += 1;
        await sleep(this.backoffFor(attempt, result.error));
        continue;
      }
      return result;
    }
  }

  /**
   * A mutating request. It is **never** retried automatically: a timeout or a
   * dropped connection could mean the write was already applied, and repeating
   * it could double-apply. The caller reconciles by re-reading.
   */
  private async write(path: string, body: unknown): Promise<Result<unknown>> {
    return this.attempt('POST', path, body);
  }

  private async attempt(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Result<unknown>> {
    const token = this.tokens.current();
    if (token === undefined) {
      return fail(ariaError('no_token', 'Sign in to reach the Directioner backend.'));
    }
    let response;
    try {
      response = await this.transport.request({
        method,
        path,
        token,
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      if (error instanceof TransportFailure) {
        return fail(ariaError('transport', error.message));
      }
      return fail(ariaError('transport', 'The backend request failed.'));
    }
    if (response.status >= 200 && response.status < 300) {
      return ok(response.body);
    }
    return fail(classifyResponse(response.status, response.body, response.retryAfterSecs));
  }

  private backoffFor(attempt: number, error: AriaBackendError): number {
    if (error.retryAfterSecs !== undefined) {
      // Cap the server hint so a hostile or mistaken value cannot stall the app.
      return Math.min(error.retryAfterSecs, 5) * 1000;
    }
    return this.backoffMs * attempt;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function malformed(what: string): AriaBackendError {
  return ariaError('malformed', `The backend returned a malformed ${what} response.`);
}

function parseExecution(value: unknown): Result<TaskExecutionDto> {
  const parsed = executionSchema.safeParse((value as ExecutionEnvelope).execution);
  if (!parsed.success) return fail(malformed('execution'));
  return ok(parsed.data as TaskExecutionDto);
}

function parseApprovalResult(value: unknown): Result<ApprovalResultEnvelope> {
  const approval = approvalSchema.safeParse((value as { approval?: unknown }).approval);
  const task = taskSchema.safeParse((value as { task?: unknown }).task);
  if (!approval.success || !task.success) return fail(malformed('approval result'));
  return ok({ approval: approval.data as ApprovalDto, task: task.data as TaskDto });
}

/**
 * Map a non-2xx response onto a classified error. The HTTP status is
 * authoritative; the backend's machine code only sharpens the message.
 */
function classifyResponse(
  status: number,
  body: unknown,
  retryAfterSecs: number | undefined,
): AriaBackendError {
  const parsed = productErrorSchema.safeParse(body);
  const message = parsed.success
    ? parsed.data.error.message
    : `The backend rejected the request (${status}).`;
  return ariaError(kindForStatus(status), redact(message), {
    ...(parsed.success && parsed.data.error.requestId !== undefined
      ? { requestId: parsed.data.error.requestId }
      : {}),
    ...(retryAfterSecs !== undefined ? { retryAfterSecs } : {}),
  });
}

/**
 * Defense in depth: a backend error message is untrusted and could echo a
 * credential. Redact anything shaped like a bearer token or an API key before
 * it is surfaced or logged.
 */
export function redact(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/\b(sk|pk|gho|ghp|xox[baprs])[-_][A-Za-z0-9._-]{6,}/g, '[redacted]')
    .replace(/(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
}

export type { AriaBackendError };
