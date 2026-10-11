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

const UNCERTAIN_KINDS: ReadonlySet<string> = new Set(['timeout', 'transport', 'conflict']);

export function classifyBackendOutcome(error: AriaBackendError): BackendOutcome {
  const outcome: BackendOutcomeClass =
    error.kind === 'unavailable'
      ? 'unavailable'
      : UNCERTAIN_KINDS.has(error.kind)
        ? 'uncertain'
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
