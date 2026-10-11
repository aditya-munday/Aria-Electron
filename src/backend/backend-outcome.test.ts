import { describe, expect, it } from 'vitest';

import { ariaError } from './product-errors.js';
import { availabilityFromOutcome, classifyBackendOutcome } from './backend-outcome.js';

describe('classifyBackendOutcome', () => {
  it('keeps a definite rejection separate from unavailability', () => {
    expect(classifyBackendOutcome(ariaError('validation', 'bad')).outcome).toBe('definite_rejection');
    expect(classifyBackendOutcome(ariaError('forbidden', 'no')).outcome).toBe('definite_rejection');
    expect(classifyBackendOutcome(ariaError('unavailable', 'down')).outcome).toBe('unavailable');
  });

  it('treats a dropped connection or timeout on a write as uncertain, never a success', () => {
    expect(classifyBackendOutcome(ariaError('transport', 'dropped')).outcome).toBe('uncertain');
    expect(classifyBackendOutcome(ariaError('timeout', 'slow')).outcome).toBe('uncertain');
  });

  it('carries the request id and status through', () => {
    const outcome = classifyBackendOutcome(
      ariaError('unavailable', 'down', { requestId: 'r1', status: 503 }),
    );
    expect(outcome.requestId).toBe('r1');
    expect(outcome.status).toBe(503);
  });
});

describe('availabilityFromOutcome', () => {
  it('maps outage kinds to offline and auth kinds to unauthenticated', () => {
    expect(availabilityFromOutcome(classifyBackendOutcome(ariaError('unavailable', 'x')))).toBe('offline');
    expect(availabilityFromOutcome(classifyBackendOutcome(ariaError('transport', 'x')))).toBe('unknown');
    expect(availabilityFromOutcome(classifyBackendOutcome(ariaError('no_token', 'x')))).toBe('unauthenticated');
    expect(availabilityFromOutcome(classifyBackendOutcome(ariaError('validation', 'x')))).toBe('online');
  });
});
