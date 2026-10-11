import { describe, expect, it } from 'vitest';

import { planOrbBackdrop } from './backdrop.js';

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

describe('orb backdrop capability', () => {
  it('reports a native vibrancy material on macOS', () => {
    const plan = planOrbBackdrop('darwin', BOUNDS);
    expect(plan.supported).toBe(true);
    expect(plan.material).toBe('vibrancy');
    expect(plan.options?.vibrancy).toBe('under-window');
    expect(plan.options?.bounds).toEqual(BOUNDS);
  });

  it('reports an acrylic material on Windows', () => {
    const plan = planOrbBackdrop('win32', BOUNDS);
    expect(plan.supported).toBe(true);
    expect(plan.material).toBe('acrylic');
    expect(plan.options?.vibrancy).toBe('acrylic');
  });

  it('honestly reports unsupported on Linux instead of faking a blur', () => {
    const plan = planOrbBackdrop('linux', BOUNDS);
    expect(plan.supported).toBe(false);
    expect(plan.material).toBe('none');
    expect(plan.options).toBeUndefined();
    expect(plan.reason).toBeDefined();
  });

  it('covers every non-macOS, non-Windows platform with the same honest refusal', () => {
    for (const platform of ['linux', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      expect(planOrbBackdrop(platform, BOUNDS).supported).toBe(false);
    }
  });

  it('uses the full display bounds, not the work area', () => {
    const plan = planOrbBackdrop('darwin', { x: 10, y: 20, width: 800, height: 600 });
    expect(plan.options?.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });
});
