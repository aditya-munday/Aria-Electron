import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { resolveSidecarCommand, verifySidecarChecksum } from './sidecar-path.js';

const BINARY = Buffer.from('frozen-sidecar-bytes');
const DIGEST = createHash('sha256').update(BINARY).digest('hex');

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
      exists: (path) => path === '/app/resources/sidecar/aria-voice/aria-voice',
    });
    expect(resolved.command).toBe('/app/resources/sidecar/aria-voice/aria-voice');
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

  it('verifies the packaged binary checksum before returning it', () => {
    const resolved = resolveSidecarCommand({
      env: {},
      resourcesPath: '/app/resources',
      exists: (path) => path === '/app/resources/sidecar/aria-voice/aria-voice',
      readFile: (path) => (path.endsWith('.sha256') ? Buffer.from(`${DIGEST}  aria-voice\n`) : BINARY),
    });
    expect(resolved.command).toBe('/app/resources/sidecar/aria-voice/aria-voice');
  });

  it('refuses a packaged binary whose bytes do not match the checksum', () => {
    expect(() =>
      resolveSidecarCommand({
        env: {},
        resourcesPath: '/app/resources',
        exists: (path) => path === '/app/resources/sidecar/aria-voice/aria-voice',
        readFile: (path) =>
          path.endsWith('.sha256') ? Buffer.from(`${DIGEST}  aria-voice\n`) : Buffer.from('tampered'),
      }),
    ).toThrow(/checksum check/);
  });
});

describe('verifySidecarChecksum', () => {
  it('is a no-op when no checksum file was staged', () => {
    expect(() =>
      verifySidecarChecksum('/app/aria-voice', () => {
        throw new Error('ENOENT');
      }),
    ).not.toThrow();
  });

  it('passes when the digest matches', () => {
    expect(() =>
      verifySidecarChecksum('/app/aria-voice', (path) =>
        path.endsWith('.sha256') ? Buffer.from(`${DIGEST}\n`) : BINARY,
      ),
    ).not.toThrow();
  });

  it('throws when the digest does not match', () => {
    expect(() =>
      verifySidecarChecksum('/app/aria-voice', (path) =>
        path.endsWith('.sha256') ? Buffer.from(`${DIGEST}\n`) : Buffer.from('other'),
      ),
    ).toThrow(/failed its checksum/);
  });
});
