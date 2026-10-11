import type { AriaBackendError } from './product-errors.js';

export type BackendAvailabilityState =
  | 'online'
  | 'offline'
  | 'unauthenticated'
  | 'unknown';

export type BackendOutcomeClass = 'definite_rejection' | 'unavailable' | 'uncertain';

export interface BackendOutcome {
  readonly outcome: BackendOutcomeClass;
  readonly kind: string;
  readonly message: string;
  readonly requestId?: string;
  readonly status?: number;
}

const OUTAGE_KINDS: ReadonlySet<string> = new Set(['unavailable']);
const UNCERTAIN_KINDS: ReadonlySet<string> = new Set(['timeout', 'transport', 'conflict']);

/**
 * Classify a backend failure. A definite rejection (validation, forbidden, not
 * found, unprocessable) is kept separate from an unavailable backend, which is
 * kept separate from an *uncertain* outcome — a dropped connection or a timeout
 * on a mutating write, where the request may or may not have been applied. An
 * uncertain outcome is never reported as a success or a cancellation.
 */
export function classifyBackendOutcome(error: AriaBackendError): BackendOutcome {
  const outcome: BackendOutcomeClass = UNCERTAIN_KINDS.has(error.kind)
    ? 'uncertain'
    : OUTAGE_KINDS.has(error.kind)
      ? 'unavailable'
      : 'definite_rejection';
  return {
    outcome,
    kind: error.kind,
    message: error.message,
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
  };
}

export function availabilityFromOutcome(outcome: BackendOutcome): BackendAvailabilityState {
  switch (outcome.outcome) {
    case 'unavailable':
      return 'offline';
    case 'uncertain':
      return 'unknown';
    case 'definite_rejection':
      return outcome.kind === 'unauthenticated' || outcome.kind === 'no_token'
        ? 'unauthenticated'
        : 'online';
  }
}
