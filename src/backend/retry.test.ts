import { describe, expect, it } from 'vitest';

import { ariaError } from './product-errors.js';
import { fail, ok, type Result } from './result.js';
import { MAX_ATTEMPTS, retryIdempotent } from './retry.js';

describe('retryIdempotent', () => {
  it('returns success without retrying a definite rejection', async () => {
    let calls = 0;
    const result = await retryIdempotent<string>(
      {
        idempotencyKey: 'k',
        run: async () => {
          calls += 1;
          return fail(ariaError('validation', 'rejected'));
        },
      },
      { sleep: async () => undefined },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries an unavailable outcome up to the bound and then reports failure honestly', async () => {
    let calls = 0;
    const result = await retryIdempotent<string>(
      {
        idempotencyKey: 'k',
        run: async () => {
          calls += 1;
          return fail(ariaError('unavailable', 'down'));
        },
      },
      { attempts: 3, sleep: async () => undefined },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    if (!result.ok) expect(result.error.kind).toBe('unavailable');
  });

  it('never exceeds the hard attempt bound', async () => {
    let calls = 0;
    await retryIdempotent<string>(
      {
        idempotencyKey: 'k',
        run: async () => {
          calls += 1;
          return fail(ariaError('transport', 'dropped'));
        },
      },
      { attempts: 99, sleep: async () => undefined },
    );
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('reuses the same idempotency key on every attempt', async () => {
    const keys: string[] = [];
    let attempt = 0;
    const result = await retryIdempotent<number>(
      {
        idempotencyKey: 'stable-key',
        run: async (key): Promise<Result<number>> => {
          keys.push(key);
          attempt += 1;
          if (attempt < 3) return fail(ariaError('timeout', 'uncertain'));
          return ok(attempt);
        },
      },
      { sleep: async () => undefined },
    );
    expect(result.ok).toBe(true);
    expect(keys).toEqual(['stable-key', 'stable-key', 'stable-key']);
  });

  it('reports each observed outcome to the caller', async () => {
    const seen: string[] = [];
    await retryIdempotent<string>(
      {
        idempotencyKey: 'k',
        run: async () => fail(ariaError('unavailable', 'down')),
      },
      {
        attempts: 2,
        sleep: async () => undefined,
        onOutcome: (outcome) => seen.push(outcome.outcome),
      },
    );
    expect(seen).toEqual(['unavailable', 'unavailable']);
  });
});
