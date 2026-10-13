/**
 * A stable, privacy-preserving device identifier for the sign-in flow.
 *
 * The device-code endpoints bind a login to a fingerprint so a code issued to
 * one machine cannot be completed from another. The CLI derives this from
 * hardware identifiers via optional native modules; Aria avoids that dependency
 * and hashes the host's stable, non-identifying attributes instead. The value is
 * opaque (a SHA-256 digest) and carries no raw hostname.
 */

import { createHash } from 'node:crypto';
import { arch, cpus, homedir, hostname, platform } from 'node:os';

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
