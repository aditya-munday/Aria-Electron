import { describe, expect, it } from 'vitest';

import { AudioRingBuffer } from './ring-buffer.js';

describe('AudioRingBuffer', () => {
  it('drains in order', () => {
    const buffer = new AudioRingBuffer(8);
    buffer.pushAll([1, 2, 3]);
    expect(Array.from(buffer.drainAll())).toEqual([1, 2, 3]);
    expect(buffer.length).toBe(0);
  });

  it('drops the oldest samples when full instead of growing', () => {
    const buffer = new AudioRingBuffer(3);
    buffer.pushAll([1, 2, 3, 4, 5]);
    expect(buffer.length).toBe(3);
    expect(buffer.stats.dropped).toBe(2);
    // The newest three survive.
    expect(Array.from(buffer.drainAll())).toEqual([3, 4, 5]);
  });

  it('drains at most the requested count', () => {
    const buffer = new AudioRingBuffer(8);
    buffer.pushAll([1, 2, 3, 4]);
    expect(Array.from(buffer.drain(2))).toEqual([1, 2]);
    expect(buffer.length).toBe(2);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new AudioRingBuffer(0)).toThrow(RangeError);
  });
});
