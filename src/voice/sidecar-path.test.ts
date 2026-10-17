import { describe, expect, it } from 'vitest';

import { resolveSidecarCommand } from './sidecar-path.js';

describe('resolveSidecarCommand', () => {
  it('prefers an explicit ARIA_SIDECAR_PATH that exists', () => {
    const resolved = resolveSidecarCommand({
      env: { ARIA_SIDECAR_PATH: '/opt/aria/aria-voice' },
      exists: () => true,
    });
    expect(resolved).toEqual({ command: '/opt/aria/aria-voice', args: [] });
  });

  it('rejects an ARIA_SIDECAR_PATH that does not exist', () => {
    expect(() =>
      resolveSidecarCommand({
        env: { ARIA_SIDECAR_PATH: '/nope/aria-voice' },
        exists: () => false,
      }),
    ).toThrow(/missing file/);
  });

  it('uses the packaged binary under resources when present', () => {
    const resolved = resolveSidecarCommand({
      env: {},
      resourcesPath: '/app/resources',
      exists: (path) => path === '/app/resources/sidecar/aria-voice',
    });
    expect(resolved.command).toBe('/app/resources/sidecar/aria-voice');
  });

  it('falls back to the repo uv environment in development', () => {
    const resolved = resolveSidecarCommand({
      env: {},
      repoRoot: '/repo',
      exists: () => false,
    });
    expect(resolved.command).toBe('uv');
    expect(resolved.args).toEqual(['run', '--project', '/repo/sidecar', 'aria-voice']);
  });

  it('throws when neither a binary nor a repo root is available', () => {
    expect(() => resolveSidecarCommand({ env: {}, exists: () => false })).toThrow(
      /not available/,
    );
  });
});
