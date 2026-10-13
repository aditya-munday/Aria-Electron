import { describe, expect, it } from 'vitest';

import {
  ariaError,
  isRetryableRead,
  kindForStatus,
  recoveryOf,
} from './product-errors.js';

describe('kindForStatus', () => {
  it('maps the statuses the backend distinguishes', () => {
    expect(kindForStatus(400)).toBe('validation');
    expect(kindForStatus(401)).toBe('unauthenticated');
    expect(kindForStatus(403)).toBe('forbidden');
    expect(kindForStatus(404)).toBe('not_found');
    expect(kindForStatus(409)).toBe('conflict');
    expect(kindForStatus(413)).toBe('too_large');
    expect(kindForStatus(422)).toBe('unprocessable');
    expect(kindForStatus(429)).toBe('rate_limited');
  });

  it('treats a 5xx as unavailable, not transport', () => {
    expect(kindForStatus(500)).toBe('unavailable');
    expect(kindForStatus(503)).toBe('unavailable');
  });

  it('treats an unmapped client status as transport', () => {
    expect(kindForStatus(418)).toBe('transport');
  });
});

describe('recoveryOf', () => {
  it('sends an expired session to authenticate and a conflict to reconcile', () => {
    expect(recoveryOf(ariaError('unauthenticated', 'x'))).toBe('authenticate');
    expect(recoveryOf(ariaError('conflict', 'x'))).toBe('reconcile');
  });

  it('is derived from the kind so two surfaces cannot disagree', () => {
    expect(recoveryOf(ariaError('timeout', 'x'))).toBe('reconcile');
    expect(recoveryOf(ariaError('rate_limited', 'x'))).toBe('wait');
  });
});

describe('isRetryableRead', () => {
  it('allows a retry for a transient or rate-limited read', () => {
    expect(isRetryableRead(ariaError('unavailable', 'x'))).toBe(true);
    expect(isRetryableRead(ariaError('rate_limited', 'x'))).toBe(true);
  });

  it('never suggests retrying an authentication or validation failure', () => {
    expect(isRetryableRead(ariaError('unauthenticated', 'x'))).toBe(false);
    expect(isRetryableRead(ariaError('validation', 'x'))).toBe(false);
    expect(isRetryableRead(ariaError('forbidden', 'x'))).toBe(false);
  });
});

describe('ariaError', () => {
  it('omits optional fields that were not supplied', () => {
    expect(ariaError('transport', 'offline')).toEqual({ kind: 'transport', message: 'offline' });
  });

  it('carries the optional request id, retry hint and status when present', () => {
    const error = ariaError('rate_limited', 'slow down', {
      requestId: 'req-1',
      retryAfterSecs: 3,
      status: 429,
    });
    expect(error.requestId).toBe('req-1');
    expect(error.retryAfterSecs).toBe(3);
    expect(error.status).toBe(429);
  });
});
