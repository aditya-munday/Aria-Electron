/**
 * A stable, privacy-preserving device identifier for the sign-in flow.
 *
 * The device-code endpoints bind a login to a fingerprint so a code issued to
 * one machine cannot be completed from another. The CLI derives this from
 * hardware identifiers via optional native modules; Aria avoids that dependency
 * and hashes the host's stable, non-identifying attributes instead. The value is
 * opaque (a SHA-256 digest) and carries no raw hostname.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';

export function deviceFingerprintId(): string {
  let cores = '0';
  try {
    cores = String(cpus().length);
  } catch {
    cores = '0';
  }
  const material = [hostname(), platform(), arch(), cores, homedir()].join('\u0000');
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Where the installation id lives. `ARIA_FINGERPRINT_PATH` wins (deployments
 * and tests); otherwise it sits next to the credential in the Aria config dir.
 * Electron's `userData` directory is the native home for it, and the shell
 * passes that path in through the environment.
 */
function fingerprintPath(env: NodeJS.ProcessEnv): string {
  const configured = env['ARIA_FINGERPRINT_PATH']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const dir = env['ARIA_CONFIG_DIR']?.trim();
  if (dir !== undefined && dir !== '') return join(dir, 'fingerprint-id');
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'aria', 'fingerprint-id');
}

/**
 * A stable installation id, generated once and persisted.
 *
 * The device-code endpoints bind a login to a fingerprint, and the status poll
 * is rejected when it does not echo the exact id the code was issued to. A
 * host-derived value is enough for that, but it can change (a kernel update
 * renames the host, a container is rebuilt), and a value that drifts mid-flow
 * is exactly the "approved in the browser but no token" failure. Persisting a
 * UUID once removes that class of failure; the host hash is the fallback when
 * the file cannot be written (a read-only config dir).
 */
export function loadOrCreateFingerprintId(env: NodeJS.ProcessEnv = process.env): string {
  const path = fingerprintPath(env);
  try {
    if (existsSync(path)) {
      const stored = readFileSync(path, 'utf8').trim();
      if (stored !== '') return stored;
    }
    const id = randomUUID();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return deviceFingerprintId();
  }
}
