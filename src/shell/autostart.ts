import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTOSTART_FILE = 'aria-desktop.desktop';

export interface AutostartFileSystem {
  read(path: string): string | undefined;
  write(path: string, contents: string): void;
  remove(path: string): void;
}

export type AutostartResult =
  | { readonly ok: true; readonly enabled: boolean; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export interface AutostartManager {
  apply(enabled: boolean): AutostartResult;
  isEnabled(): boolean;
}

export interface AutostartDeps {
  /** The XDG autostart directory, e.g. `~/.config/autostart`. */
  readonly directory: string;
  /** The absolute path of the executable to launch at sign-in. */
  readonly execPath: string;
  readonly fs?: AutostartFileSystem;
}

export function autostartEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Aria',
    'Comment=Start Aria when you sign in',
    `Exec=${execPath}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function nodeFileSystem(): AutostartFileSystem {
  return {
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    write: (path, contents) => {
      writeFileSync(path, contents, 'utf8');
    },
    remove: (path) => {
      rmSync(path, { force: true });
    },
  };
}

/**
 * Applies the "start when you sign in" preference as an XDG autostart entry.
 * The result is reported, never assumed: a read-only config directory returns a
 * failure the UI can show, rather than silently claiming the setting took.
 */
export function createAutostartManager(deps: AutostartDeps): AutostartManager {
  const fs = deps.fs ?? nodeFileSystem();
  const path = join(deps.directory, AUTOSTART_FILE);
  return {
    apply: (enabled): AutostartResult => {
      try {
        if (!enabled) {
          fs.remove(path);
          return { ok: true, enabled: false, path };
        }
        fs.write(path, autostartEntry(deps.execPath));
        return { ok: true, enabled: true, path };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `Could not update ${path}: ${reason}` };
      }
    },
    isEnabled: (): boolean => fs.read(path) !== undefined,
  };
}
