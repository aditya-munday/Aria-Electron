/**
 * The durable account credential.
 *
 * Aria stores one Beyonders account credential on disk so a signed-in user
 * stays signed in across restarts. The file is deliberately the *same* shape the
 * Directioner CLI writes (`~/.config/directioner/credentials.json`,
 * `{ default: { …, authToken } }`), so an existing CLI login is picked up for
 * free and Aria never invents a second credential format.
 *
 * The token is a bearer credential: the file is created owner-read/write only
 * and its mode is re-tightened on every read and write, because `writeFileSync`
 * only applies `mode` when it *creates* the file.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredCredential {
  readonly authToken: string;
  readonly id?: string;
  readonly name?: string;
  readonly email?: string;
  readonly fingerprintId?: string;
  readonly fingerprintHash?: string;
}

const CREDENTIALS_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

/**
 * The config directory Aria reads and writes. `ARIA_CONFIG_DIR` wins so a
 * deployment can confine it; otherwise the XDG config home is used.
 */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['ARIA_CONFIG_DIR']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'aria');
}

/**
 * Where the credential lives. Aria's own directory is preferred, but when only
 * a CLI login exists the CLI path is used so the two surfaces share one login.
 */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const ariaPath = join(defaultConfigDir(env), 'credentials.json');
  if (existsSync(ariaPath)) return ariaPath;
  const cliDir = env['DIRECTIONER_CONFIG_DIR']?.trim();
  if (cliDir !== undefined && cliDir !== '') return join(cliDir, 'credentials.json');
  const cliPath = join(
    env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config'),
    'directioner',
    'credentials.json',
  );
  return existsSync(cliPath) ? cliPath : ariaPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Best-effort: clamp the file to owner read/write. Never throws — a failed
 * chmod must not cost the user their login — and is skipped on Windows, where
 * POSIX mode bits do not apply.
 */
function tightenFileMode(path: string): void {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(path).mode & 0o777) !== CREDENTIALS_FILE_MODE) {
      chmodSync(path, CREDENTIALS_FILE_MODE);
    }
  } catch {
    // A missing file or an unsupported filesystem is not fatal.
  }
}

export class CredentialStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** A store at the default location, honouring the environment overrides. */
  static default(env: NodeJS.ProcessEnv = process.env): CredentialStore {
    return new CredentialStore(defaultCredentialsPath(env));
  }

  filePath(): string {
    return this.path;
  }

  /** Read the stored credential, or `undefined` when absent or malformed. */
  load(): StoredCredential | undefined {
    if (!existsSync(this.path)) return undefined;
    tightenFileMode(this.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const profile = parsed['default'];
    if (!isRecord(profile)) return undefined;
    const authToken = optionalString(profile['authToken']);
    if (authToken === undefined) return undefined;
    return {
      authToken,
      ...(optionalString(profile['id']) !== undefined ? { id: profile['id'] as string } : {}),
      ...(optionalString(profile['name']) !== undefined ? { name: profile['name'] as string } : {}),
      ...(optionalString(profile['email']) !== undefined ? { email: profile['email'] as string } : {}),
      ...(optionalString(profile['fingerprintId']) !== undefined
        ? { fingerprintId: profile['fingerprintId'] as string }
        : {}),
      ...(optionalString(profile['fingerprintHash']) !== undefined
        ? { fingerprintHash: profile['fingerprintHash'] as string }
        : {}),
    };
  }

  /**
   * Persist the credential atomically. Unrelated profiles in the file are
   * preserved so a shared CLI/Aria file never loses another entry.
   */
  save(credential: StoredCredential): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: CONFIG_DIR_MODE });
    const existing = this.readObject();
    const next = { ...existing, default: { ...credential } };
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
    renameSync(temporary, this.path);
    tightenFileMode(this.path);
  }

  /** Remove the stored credential, preserving unrelated profiles. */
  clear(): void {
    if (!existsSync(this.path)) return;
    const existing = this.readObject();
    if (!('default' in existing)) return;
    delete existing['default'];
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
    renameSync(temporary, this.path);
    tightenFileMode(this.path);
  }

  private readObject(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return isRecord(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }
}
