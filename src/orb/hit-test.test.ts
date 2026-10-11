import { describe, expect, it } from 'vitest';

import { orbHitTest } from './hit-test.js';
import { ORB_DIAMETER, ORB_WINDOW_SIZE } from './window-options.js';

describe('orb hit test', () => {
  it('accepts the exact centre of the circle', () => {
    const c = ORB_WINDOW_SIZE / 2;
    expect(orbHitTest(c, c)).toBe(true);
  });

  it('accepts a point inside the circle radius', () => {
    const c = ORB_WINDOW_SIZE / 2;
    expect(orbHitTest(c, c - ORB_DIAMETER / 2 + 1)).toBe(true);
  });

  it('rejects the window corners', () => {
    expect(orbHitTest(0, 0)).toBe(false);
    expect(orbHitTest(ORB_WINDOW_SIZE, ORB_WINDOW_SIZE)).toBe(false);
  });

  it('rejects a point just outside the circle on the axis', () => {
    const c = ORB_WINDOW_SIZE / 2;
    expect(orbHitTest(c + ORB_DIAMETER / 2 + 1, c)).toBe(false);
  });

  it('honours an explicit window size and diameter', () => {
    expect(orbHitTest(50, 50, { windowSize: 100, diameter: 80 })).toBe(true);
    expect(orbHitTest(5, 5, { windowSize: 100, diameter: 80 })).toBe(false);
  });
});
