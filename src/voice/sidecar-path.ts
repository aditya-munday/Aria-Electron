/**
 * Resolving the voice sidecar executable.
 *
 * The sidecar is built per target and shipped under `extraResources` (outside
 * the asar, executable). In development it is run from the repo via the pinned
 * `uv` environment. Both are overridable with `ARIA_SIDECAR_PATH` so an operator
 * can point at a custom build.
 *
 * Resolution never silently falls back to a wrong binary: an explicit
 * `ARIA_SIDECAR_PATH` that does not exist is a typed error, so the failure is
 * visible rather than a mysterious "sidecar did not start".
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SidecarCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ResolveSidecarOptions {
  /** `process.env` in production; injected for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Electron's `process.resourcesPath`; undefined outside a packaged app. */
  readonly resourcesPath?: string;
  /** The repo root, for the development path; injected for tests. */
  readonly repoRoot?: string;
  /** Whether a path exists; injected for tests. */
  readonly exists?: (path: string) => boolean;
}

const SIDECAR_BINARY_NAME = 'aria-voice';

/**
 * Resolve how to launch the sidecar.
 *
 * Precedence:
 *   1. `ARIA_SIDECAR_PATH` — an explicit override (must exist).
 *   2. The packaged binary under `<resources>/sidecar/aria-voice`.
 *   3. The repo's `uv` environment, run from source.
 */
export function resolveSidecarCommand(options: ResolveSidecarOptions = {}): SidecarCommand {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const override = env['ARIA_SIDECAR_PATH']?.trim();
  if (override !== undefined && override !== '') {
    if (!exists(override)) {
      throw new Error(`ARIA_SIDECAR_PATH points at a missing file: ${override}`);
    }
    return { command: override, args: [] };
  }

  if (options.resourcesPath !== undefined) {
    const packaged = join(options.resourcesPath, 'sidecar', SIDECAR_BINARY_NAME);
    if (exists(packaged)) return { command: packaged, args: [] };
  }

  const repoRoot = options.repoRoot;
  if (repoRoot !== undefined) {
    return {
      command: 'uv',
      args: ['run', '--project', join(repoRoot, 'sidecar'), 'aria-voice'],
    };
  }

  throw new Error('The voice sidecar is not available: no packaged binary and no repo root.');
}
