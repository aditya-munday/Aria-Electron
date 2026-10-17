import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGpuCrashMarker,
  decideGpu,
  detectSession,
  graphicsMode,
  ozonePlatformArgs,
  probeGpu,
  summarizeGpuFeatureStatus,
  type GpuProbeDeps,
} from './gpu-policy.js';

function deps(overrides: Partial<Record<'exists' | 'readable', boolean>>): GpuProbeDeps {
  const exists = overrides.exists ?? false;
  const readable = overrides.readable ?? exists;
  return { exists: () => exists, readable: () => readable };
}

function pathDeps(present: readonly string[]): GpuProbeDeps {
  return { exists: (p) => present.includes(p), readable: (p) => present.includes(p) };
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

  it('honours the ARIA_GRAPHICS tri-state', () => {
    expect(graphicsMode({ ARIA_GRAPHICS: 'off' })).toBe('off');
    expect(graphicsMode({ ARIA_GRAPHICS: 'ON' })).toBe('on');
    expect(graphicsMode({})).toBe('auto');
    expect(probeGpu('linux', { ARIA_GRAPHICS: 'off' }, deps({ exists: true, readable: true })).enabled).toBe(false);
    expect(probeGpu('linux', { ARIA_GRAPHICS: 'on' }, deps({})).enabled).toBe(true);
  });

  it('accepts an alternate render node beyond renderD128/card0', () => {
    expect(probeGpu('linux', {}, pathDeps(['/dev/dri/renderD129'])).enabled).toBe(true);
    expect(probeGpu('linux', {}, pathDeps(['/dev/dri/card1'])).enabled).toBe(true);
  });

  it('accepts an NVIDIA control node when no DRM node exists', () => {
    const decision = probeGpu('linux', {}, pathDeps(['/dev/nvidia0', '/dev/nvidiactl']));
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('NVIDIA');
  });
});

describe('detectSession', () => {
  it('reads XDG_SESSION_TYPE first', () => {
    expect(detectSession('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe('wayland');
    expect(detectSession('linux', { XDG_SESSION_TYPE: 'x11' })).toBe('x11');
  });

  it('falls back to the display variables, preferring Wayland', () => {
    expect(detectSession('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland');
    expect(detectSession('linux', { DISPLAY: ':0' })).toBe('x11');
    expect(detectSession('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland');
    expect(detectSession('linux', {})).toBe('unknown');
  });

  it('is unknown off Linux', () => {
    expect(detectSession('darwin', { XDG_SESSION_TYPE: 'wayland' })).toBe('unknown');
  });
});

describe('ozonePlatformArgs', () => {
  it('asks for the Wayland backend on a Wayland session', () => {
    expect(ozonePlatformArgs('linux', { XDG_SESSION_TYPE: 'wayland' })).toEqual([
      '--ozone-platform-hint=auto',
    ]);
  });

  it('adds nothing on X11 or off Linux', () => {
    expect(ozonePlatformArgs('linux', { XDG_SESSION_TYPE: 'x11' })).toEqual([]);
    expect(ozonePlatformArgs('darwin', { XDG_SESSION_TYPE: 'wayland' })).toEqual([]);
  });

  it('honours an explicit ARIA_OZONE hint', () => {
    expect(ozonePlatformArgs('linux', { ARIA_OZONE: 'x11' })).toEqual(['--ozone-platform-hint=x11']);
  });
});

describe('summarizeGpuFeatureStatus', () => {
  it('reports unavailable for no status', () => {
    expect(summarizeGpuFeatureStatus(undefined)).toContain('unavailable');
  });

  it('summarizes the feature map', () => {
    expect(summarizeGpuFeatureStatus({ gpu_compositing: 'enabled', webgl: 'enabled' })).toContain(
      'webgl=enabled',
    );
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
