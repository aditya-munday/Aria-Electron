/**
 * Chromium's GPU path is opt-in here, and only when the host can actually
 * support it.
 *
 * The failure this guards against: on a machine whose GPU stack is half-present
 * (a Mesa driver that will not load, a container without a usable render node,
 * a virtual GPU), Chromium's GPU initialisation fails — `vaInitialize failed`,
 * `MESA-LOADER: failed to open dri` — and the process dies with SIGSEGV before
 * any window appears. The user sees "aria-desktop" crash instantly and cannot
 * reach the wake word at all. A GPU that renders nothing is worthless; a UI that
 * never starts is worse, so hardware acceleration is enabled only when a usable
 * render node is present, and a run that crashed while using it never tries
 * again on that machine.
 */
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface GpuDecision {
  /** True to keep Chromium's GPU path; false to force software rendering. */
  readonly enabled: boolean;
  /** A short, human-readable reason, logged so a crash report is actionable. */
  readonly reason: string;
}

export interface GpuProbeDeps {
  readonly exists: (path: string) => boolean;
  readonly readable: (path: string) => boolean;
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** The DRM nodes a Chromium GPU process needs to initialise a renderer. */
const DRM_NODES = ['/dev/dri/renderD128', '/dev/dri/card0'] as const;

/**
 * Whether the host can run Chromium's GPU path. Anything other than a readable
 * DRM node is treated as "no", because the alternative is the startup crash.
 */
export function probeGpu(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: GpuProbeDeps,
): GpuDecision {
  // An explicit override always wins, so a user can trade stability for the GPU
  // (or the reverse) without a rebuild.
  if (truthy(env.ARIA_DISABLE_GPU)) {
    return { enabled: false, reason: 'ARIA_DISABLE_GPU is set' };
  }
  if (truthy(env.ARIA_ENABLE_GPU)) {
    return { enabled: true, reason: 'ARIA_ENABLE_GPU is set' };
  }
  if (platform !== 'linux') {
    return { enabled: true, reason: `hardware acceleration is the default on ${platform}` };
  }
  const node = DRM_NODES.find((candidate) => deps.exists(candidate) && deps.readable(candidate));
  if (node === undefined) {
    return { enabled: false, reason: 'no readable DRM render node (/dev/dri)' };
  }
  return { enabled: true, reason: `DRM render node ${node}` };
}

export interface GpuCrashState {
  /** Consecutive prior runs that died while using the GPU path. */
  readonly crashes: number;
}

/**
 * Fold the crash history into the probe. A GPU run that crashed is proof the
 * host cannot run it, so the next launch forces software rather than repeating
 * the crash. The escape hatch is `ARIA_ENABLE_GPU`, which `probeGpu` reports as
 * an explicit request and is honoured here too.
 */
export function decideGpu(
  probe: GpuDecision,
  crash: GpuCrashState,
  env: NodeJS.ProcessEnv,
): GpuDecision {
  if (!probe.enabled) return probe;
  if (crash.crashes > 0 && !truthy(env.ARIA_ENABLE_GPU)) {
    return {
      enabled: false,
      reason: `the previous ${crash.crashes === 1 ? 'run' : `${crash.crashes} runs`} crashed with the GPU enabled`,
    };
  }
  return probe;
}

export interface GpuCrashMarker {
  /** Prior GPU-mode crashes recorded on disk (0 when none or unreadable). */
  read(): number;
  /** Record that a GPU-mode run is starting, so a crash is attributed to it. */
  arm(): void;
  /** Clear the record after a GPU-mode run exits cleanly. */
  clear(): void;
}

const MARKER_VERSION = 1;

/**
 * A tiny on-disk sentinel. It is armed before a GPU-mode run and cleared only on
 * a clean exit, so any crash leaves it behind and the next launch backs off to
 * software. Software-mode runs never touch it, so they cannot be mistaken for
 * GPU failures and cannot loop.
 */
export function createGpuCrashMarker(path: string): GpuCrashMarker {
  return {
    read: () => {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; gpuCrashes?: number };
        if (raw.version !== MARKER_VERSION || typeof raw.gpuCrashes !== 'number') return 0;
        return raw.gpuCrashes > 0 ? raw.gpuCrashes : 0;
      } catch {
        return 0;
      }
    },
    arm: () => {
      const next = ((): number => {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; gpuCrashes?: number };
          if (raw.version === MARKER_VERSION && typeof raw.gpuCrashes === 'number' && raw.gpuCrashes > 0) {
            return raw.gpuCrashes + 1;
          }
        } catch {
          // No readable marker: this is the first attempt.
        }
        return 1;
      })();
      try {
        writeFileSync(path, JSON.stringify({ version: MARKER_VERSION, gpuCrashes: next }));
      } catch {
        // A marker that cannot be written only costs the fallback; never fatal.
      }
    },
    clear: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // Ignore: a stale marker is handled on the next launch.
      }
    },
  };
}

/** The real filesystem probe used at startup. */
export const nodeGpuProbeDeps: GpuProbeDeps = {
  exists: (path) => existsSync(path),
  readable: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
};
