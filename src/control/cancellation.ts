import type { SupervisionRecord } from '../supervisor/task-store.js';

export type CancellationOutcomeKind = 'confirmed' | 'failed' | 'not_cancellable';

export type CancellationReason =
  | 'confirmed'
  | 'execution_already_terminated'
  | 'grace_elapsed'
  | 'backend_unavailable'
  | 'outcome_unknown'
  | 'not_dispatched'
  | 'not_tracked';

export interface CancellationOutcome {
  readonly kind: CancellationOutcomeKind;
  readonly taskId: string;
  readonly reason: CancellationReason;
  readonly detail: string;
  readonly observedExecutionState?: string;
  readonly observedCancellation?: string;
}

export const DEFAULT_CANCEL_GRACE_MS = 10_000;

export interface ConfirmCancellationOptions {
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ConfirmCancellationDeps {
  readonly requestCancellation: (taskId: string) => Promise<{ readonly ok: boolean }>;
  readonly observe: (taskId: string) => Promise<SupervisionRecord | undefined>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isTerminated(record: SupervisionRecord): boolean {
  const state = record.executionState;
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function describeCancellation(outcome: CancellationOutcome): string {
  switch (outcome.kind) {
    case 'confirmed':
      return 'Cancelled: the worker confirmed the stop.';
    case 'not_cancellable':
      return `Not cancelled: ${outcome.detail}`;
    case 'failed':
      return `Cancellation failed: ${outcome.detail}`;
  }
}

/**
 * Request cancellation and only report `confirmed` when the authoritative
 * execution state was observed to reach `cancelled`. If the agent does not stop
 * within the grace period the outcome is `failed`; a non-terminal task whose
 * cancellation is still pending is `unconfirmed`; a terminal task that never
 * reached `cancelled` is `not_cancellable`. An unknown is never reported as a
 * confirmed stop.
 */
export async function confirmCancellation(
  taskId: string,
  deps: ConfirmCancellationDeps,
  options: ConfirmCancellationOptions = {},
): Promise<CancellationOutcome> {
  const graceMs = options.graceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const requested = await deps.requestCancellation(taskId);

  const deadline = now() + graceMs;
  let record = await deps.observe(taskId);

  for (;;) {
    if (record !== undefined && record.executionState === 'cancelled') {
      return confirmed(taskId, record, 'confirmed', 'The worker confirmed the stop.');
    }
    if (record !== undefined && isTerminated(record)) {
      return {
        kind: 'not_cancellable',
        taskId,
        reason: 'execution_already_terminated',
        detail: `The work already reached '${record.executionState ?? record.status}' and could not be stopped.`,
        ...stateOf(record),
      };
    }
    if (now() >= deadline) {
      if (!requested.ok) {
        return {
          kind: 'failed',
          taskId,
          reason: 'backend_unavailable',
          detail: 'The stop request could not be delivered to the Backend.',
          ...(record !== undefined ? stateOf(record) : {}),
        };
      }
      return {
        kind: 'failed',
        taskId,
        reason: 'grace_elapsed',
        detail: `The worker did not stop within the ${graceMs} ms grace period.`,
        ...(record !== undefined ? stateOf(record) : {}),
      };
    }
    await sleep(pollIntervalMs);
    record = await deps.observe(taskId);
  }
}

function confirmed(
  taskId: string,
  record: SupervisionRecord,
  reason: CancellationReason,
  detail: string,
): CancellationOutcome {
  return { kind: 'confirmed', taskId, reason, detail, ...stateOf(record) };
}

function stateOf(
  record: SupervisionRecord,
): { observedExecutionState?: string; observedCancellation?: string } {
  return {
    ...(record.executionState !== undefined ? { observedExecutionState: record.executionState } : {}),
    observedCancellation: record.cancellation,
  };
}
