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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  /** Reads a file as bytes; injected for tests. */
  readonly readFile?: (path: string) => Buffer;
}

const SIDECAR_BINARY_NAME = 'aria-voice';

/**
 * Verify a staged sidecar against the checksum recorded next to it.
 *
 * The build stages `aria-voice.sha256` beside the binary; a packaged app
 * verifies it before spawn so a tampered or truncated resource is refused
 * rather than executed. When no checksum is recorded (a dev/unstaged build)
 * there is nothing to check and the call is a no-op, never a silent pass over a
 * mismatch that was actually recorded.
 */
export function verifySidecarChecksum(
  binaryPath: string,
  readFile: (path: string) => Buffer = readFileSync,
): void {
  let recorded: string;
  try {
    recorded = (readFile(`${binaryPath}.sha256`).toString('utf8').trim().split(/\s+/)[0]) ?? '';
  } catch {
    return;
  }
  if (recorded === '') return;
  const digest = createHash('sha256').update(readFile(binaryPath)).digest('hex');
  if (digest !== recorded) {
    throw new Error(
      `The voice sidecar failed its checksum check (expected ${recorded}, got ${digest}).`,
    );
  }
}

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
    // electron-builder stages the one-dir bundle as `resources/sidecar/aria-voice/`,
    // so the executable is the same-named file inside it.
    const packaged = join(
      options.resourcesPath,
      'sidecar',
      SIDECAR_BINARY_NAME,
      SIDECAR_BINARY_NAME,
    );
    if (exists(packaged)) {
      // The packaged binary is the one that runs unattended; verify it against
      // the build-time checksum before it is spawned.
      if (options.readFile !== undefined) verifySidecarChecksum(packaged, options.readFile);
      else verifySidecarChecksum(packaged);
      return { command: packaged, args: [] };
    }
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
