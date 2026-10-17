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

/** The `ARIA_GRAPHICS` tri-state, mirroring the "Graphics acceleration" setting. */
export type GraphicsMode = 'auto' | 'on' | 'off';

export function graphicsMode(env: NodeJS.ProcessEnv): GraphicsMode {
  const raw = env['ARIA_GRAPHICS']?.trim().toLowerCase();
  if (raw === 'on' || raw === 'always' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'off' || raw === 'never' || raw === 'false' || raw === '0') return 'off';
  return 'auto';
}

/** The display session, which decides the Ozone platform hint. */
export type GpuSession = 'x11' | 'wayland' | 'unknown';

export function detectSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): GpuSession {
  if (platform !== 'linux') return 'unknown';
  const type = env['XDG_SESSION_TYPE']?.trim().toLowerCase();
  if (type === 'wayland') return 'wayland';
  if (type === 'x11') return 'x11';
  // A Wayland display wins over `DISPLAY`, which XWayland also sets.
  if ((env['WAYLAND_DISPLAY'] ?? '').trim() !== '') return 'wayland';
  if ((env['DISPLAY'] ?? '').trim() !== '') return 'x11';
  return 'unknown';
}

const DRM_RENDER_NODES = Array.from({ length: 8 }, (_, i) => `/dev/dri/renderD${128 + i}`);
const DRM_CARD_NODES = Array.from({ length: 4 }, (_, i) => `/dev/dri/card${i}`);
const NVIDIA_NODES = ['/dev/nvidia0', '/dev/nvidiactl'] as const;

/**
 * Whether the host can run Chromium's GPU path. A readable render node, a
 * usable card node, or NVIDIA's control nodes all count; anything else is "no",
 * because the alternative is the startup crash.
 */
export function probeGpu(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: GpuProbeDeps,
): GpuDecision {
  if (truthy(env['ARIA_DISABLE_GPU']) || graphicsMode(env) === 'off') {
    return { enabled: false, reason: 'graphics acceleration is disabled' };
  }
  if (truthy(env['ARIA_ENABLE_GPU']) || graphicsMode(env) === 'on') {
    return { enabled: true, reason: 'graphics acceleration is forced on' };
  }
  if (platform !== 'linux') {
    return { enabled: true, reason: `hardware acceleration is the default on ${platform}` };
  }
  const usable = (nodes: readonly string[]): string | undefined =>
    nodes.find((candidate) => deps.exists(candidate) && deps.readable(candidate));
  const render = usable(DRM_RENDER_NODES);
  if (render !== undefined) return { enabled: true, reason: `DRM render node ${render}` };
  const card = usable(DRM_CARD_NODES);
  if (card !== undefined) return { enabled: true, reason: `DRM card node ${card}` };
  const nvidia = usable(NVIDIA_NODES);
  if (nvidia !== undefined) return { enabled: true, reason: `NVIDIA control node ${nvidia}` };
  return { enabled: false, reason: 'no readable DRM render node (/dev/dri) or NVIDIA node' };
}

/**
 * The Ozone command-line switches for the session: the native Wayland backend
 * when one is present (it still falls back to X11), nothing on X11. `ARIA_OZONE`
 * overrides the hint.
 */
export function ozonePlatformArgs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'linux') return [];
  const forced = env['ARIA_OZONE']?.trim();
  if (forced !== undefined && forced !== '') return [`--ozone-platform-hint=${forced}`];
  if (detectSession(platform, env) === 'wayland') return ['--ozone-platform-hint=auto'];
  return [];
}

/** A one-line summary of Chromium's post-init GPU feature status, for logs. */
export function summarizeGpuFeatureStatus(status: object | undefined): string {
  if (status === undefined) return 'gpu feature status unavailable';
  const parts = Object.entries(status)
    .filter(([key]) => key !== 'gpu_compositing' && key !== 'multiple_raster_threads')
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(', ') : 'gpu feature status empty';
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
