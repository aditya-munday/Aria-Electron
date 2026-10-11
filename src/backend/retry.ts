import { ariaError } from './product-errors.js';
import { fail, ok, type Result } from './result.js';
import { classifyBackendOutcome, type BackendOutcome } from './backend-outcome.js';

export const MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 50;

export interface RetryOptions {
  /** Total attempts including the first. Bounded by {@link MAX_ATTEMPTS}. */
  readonly attempts?: number;
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onOutcome?: (outcome: BackendOutcome, attempt: number) => void;
}

export interface IdempotentOperation<T> {
  /** Stable across attempts so the Backend can deduplicate a retried write. */
  readonly idempotencyKey: string;
  readonly run: (idempotencyKey: string) => Promise<Result<T>>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Run an idempotent operation with bounded retries. Each attempt reuses the same
 * idempotency key, so a retried write cannot duplicate a side effect. Only an
 * unavailable or uncertain outcome is retried; a definite rejection is returned
 * as-is. The final, honest result is always returned — a persistent outage
 * resolves as a failure, never as a fabricated success.
 */
export async function retryIdempotent<T>(
  operation: IdempotentOperation<T>,
  options: RetryOptions = {},
): Promise<Result<T>> {
  const attempts = Math.min(Math.max(options.attempts ?? MAX_ATTEMPTS, 1), MAX_ATTEMPTS);
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  let last: Result<T> = fail(ariaError('unavailable', 'The operation was not attempted.'));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await operation.run(operation.idempotencyKey);
    if (last.ok) return last;
    const outcome = classifyBackendOutcome(last.error);
    options.onOutcome?.(outcome, attempt);
    const retryable = outcome.outcome === 'unavailable' || outcome.outcome === 'uncertain';
    if (!retryable || attempt === attempts) return last;
    await sleep(backoffMs * attempt);
  }
  return last;
}

export { ok };
