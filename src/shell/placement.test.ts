import { describe, expect, it } from 'vitest';

import { clamp, contains } from './geometry.js';
import {
  ORB_RIGHT_MARGIN,
  ORB_RIGHT_SHIFT_FRACTION,
  ORB_VERTICAL_CENTER_FRACTION,
  orbCircle,
  placeOrb,
  type ScreenInfo,
} from './placement.js';

const WORK: ScreenInfo = {
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  primary: true,
};

const SIZE = { width: 120, height: 120 };

describe('orb placement', () => {
  it('anchors near the right edge, nudged right by the configured shift', () => {
    const placed = placeOrb(WORK.workArea, SIZE);
    expect(placed.x).toBe(1440 - 120 - ORB_RIGHT_MARGIN + 120 * ORB_RIGHT_SHIFT_FRACTION);
  });

  it('sits in the upper part of the work area, not centred', () => {
    const placed = placeOrb(WORK.workArea, SIZE);
    expect(placed.y).toBe(900 * ORB_VERTICAL_CENTER_FRACTION - SIZE.height / 2);
    expect(placed.y).toBeLessThan((900 - SIZE.height) / 2);
  });

  it('keeps the window size exactly, never the screen size', () => {
    const placed = placeOrb(WORK.workArea, SIZE);
    expect(placed.width).toBe(SIZE.width);
    expect(placed.height).toBe(SIZE.height);
  });

  it('respects a work area with a non-zero origin', () => {
    const placed = placeOrb({ x: 100, y: 40, width: 800, height: 600 }, SIZE);
    expect(placed.x).toBe(100 + 800 - 120 - ORB_RIGHT_MARGIN + 120 * ORB_RIGHT_SHIFT_FRACTION);
    expect(placed.y).toBe(40 + 600 * ORB_VERTICAL_CENTER_FRACTION - SIZE.height / 2);
  });

  it('clamps back onto a work area too small for the window', () => {
    const placed = placeOrb({ x: 0, y: 0, width: 80, height: 80 }, SIZE);
    expect(placed.x).toBe(0);
    expect(placed.y).toBe(0);
  });

  it('places the painted circle at the centre of the window bounds', () => {
    const bounds = placeOrb(WORK.workArea, SIZE);
    const circle = orbCircle(bounds, 96);
    expect(circle.width).toBe(96);
    expect(circle.height).toBe(96);
    expect(circle.x).toBe(bounds.x + (bounds.width - 96) / 2);
    expect(circle.y).toBe(bounds.y + (bounds.height - 96) / 2);
    expect(contains(circle, { x: circle.x + 48, y: circle.y + 48 })).toBe(true);
  });

  it('circle never exceeds the bounds it is painted in', () => {
    const circle = orbCircle({ x: 0, y: 0, width: 40, height: 40 }, 96);
    expect(circle.width).toBe(40);
    expect(circle.height).toBe(40);
  });
});

describe('geometry primitives', () => {
  it('clamp orders min and max even when inverted', () => {
    expect(clamp(10, 0, 5)).toBe(5);
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(3, 5, 0)).toBe(5);
  });

  it('contains is inclusive of edges', () => {
    expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 10 })).toBe(true);
    expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 5 })).toBe(false);
  });
});
