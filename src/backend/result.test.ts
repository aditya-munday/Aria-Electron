import { describe, expect, it } from 'vitest';

import { fail, ok } from './result.js';
import { ariaError } from './product-errors.js';

describe('Result helpers', () => {
  it('wraps a success value with a discriminated tag', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(42);
  });

  it('wraps a classified failure, never a thrown value', () => {
    const error = ariaError('forbidden', 'You do not have access to that.');
    const result = fail<number>(error);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
    expect(result.error.kind).toBe('forbidden');
  });
});
