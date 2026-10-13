import { describe, expect, it } from 'vitest';

import { clamp, contains, type Rect } from './geometry.js';

const rect: Rect = { x: 10, y: 20, width: 100, height: 50 };

describe('clamp', () => {
  it('returns the value inside the range unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to the nearer bound', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('collapses an inverted range to its minimum rather than returning NaN', () => {
    expect(clamp(5, 10, 0)).toBe(10);
  });
});

describe('contains', () => {
  it('includes points on the edges', () => {
    expect(contains(rect, { x: 10, y: 20 })).toBe(true);
    expect(contains(rect, { x: 110, y: 70 })).toBe(true);
  });

  it('excludes points outside any edge', () => {
    expect(contains(rect, { x: 9, y: 30 })).toBe(false);
    expect(contains(rect, { x: 30, y: 71 })).toBe(false);
    expect(contains(rect, { x: -1, y: -1 })).toBe(false);
  });
});
