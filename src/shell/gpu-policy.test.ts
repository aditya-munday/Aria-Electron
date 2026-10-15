import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGpuCrashMarker,
  decideGpu,
  probeGpu,
  type GpuProbeDeps,
} from './gpu-policy.js';

function deps(overrides: Partial<Record<'exists' | 'readable', boolean>>): GpuProbeDeps {
  const exists = overrides.exists ?? false;
  const readable = overrides.readable ?? exists;
  return { exists: () => exists, readable: () => readable };
}

describe('probeGpu', () => {
  it('uses software rendering when Linux has no DRM node', () => {
    const decision = probeGpu('linux', {}, deps({}));
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('DRM');
  });

  it('uses software rendering when the DRM node is not readable', () => {
    const decision = probeGpu('linux', {}, deps({ exists: true, readable: false }));
    expect(decision.enabled).toBe(false);
  });

  it('enables the GPU when a readable DRM node is present', () => {
    const decision = probeGpu('linux', {}, deps({ exists: true, readable: true }));
    expect(decision.enabled).toBe(true);
  });

  it('leaves other platforms at their default', () => {
    expect(probeGpu('darwin', {}, deps({})).enabled).toBe(true);
    expect(probeGpu('win32', {}, deps({})).enabled).toBe(true);
  });

  it('honours the explicit overrides', () => {
    expect(probeGpu('linux', { ARIA_DISABLE_GPU: '1' }, deps({ exists: true, readable: true })).enabled).toBe(false);
    expect(probeGpu('linux', { ARIA_ENABLE_GPU: '1' }, deps({})).enabled).toBe(true);
  });
});

describe('decideGpu', () => {
  const probeOn = { enabled: true, reason: 'node' };
  const probeOff = { enabled: false, reason: 'no node' };

  it('keeps the GPU when there is no crash history', () => {
    expect(decideGpu(probeOn, { crashes: 0 }, {}).enabled).toBe(true);
  });

  it('backs off to software after a GPU crash', () => {
    const decision = decideGpu(probeOn, { crashes: 1 }, {});
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('crashed');
  });

  it('lets an explicit request override the crash backoff', () => {
    expect(decideGpu(probeOn, { crashes: 3 }, { ARIA_ENABLE_GPU: '1' }).enabled).toBe(true);
  });

  it('stays off when the probe already said software', () => {
    expect(decideGpu(probeOff, { crashes: 0 }, {}).enabled).toBe(false);
  });
});

describe('createGpuCrashMarker', () => {
  const dirs: string[] = [];
  const markerPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gpu-marker-'));
    dirs.push(dir);
    return join(dir, 'gpu-crash.json');
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads zero when no marker exists', () => {
    expect(createGpuCrashMarker(markerPath()).read()).toBe(0);
  });

  it('leaves a marker behind after a crash (no clear)', () => {
    const path = markerPath();
    const marker = createGpuCrashMarker(path);
    marker.arm();
    // A crash means `clear` never runs, so a fresh process still sees it.
    expect(createGpuCrashMarker(path).read()).toBe(1);
  });

  it('counts repeated crashes', () => {
    const path = markerPath();
    createGpuCrashMarker(path).arm();
    createGpuCrashMarker(path).arm();
    expect(createGpuCrashMarker(path).read()).toBe(2);
  });

  it('clears the marker after a clean exit', () => {
    const path = markerPath();
    const marker = createGpuCrashMarker(path);
    marker.arm();
    marker.clear();
    expect(createGpuCrashMarker(path).read()).toBe(0);
  });
});
