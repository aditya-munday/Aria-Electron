import { describe, expect, it } from 'vitest';

import {
  AUTOSTART_FILE,
  autostartEntry,
  createAutostartManager,
  type AutostartFileSystem,
} from './autostart.js';

function fakeFs(initial: Record<string, string> = {}): AutostartFileSystem & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (path) => files.get(path),
    write: (path, contents) => {
      files.set(path, contents);
    },
    remove: (path) => {
      files.delete(path);
    },
  };
}

const directory = '/home/user/.config/autostart';
const path = `${directory}/${AUTOSTART_FILE}`;

describe('autostart entry', () => {
  it('names the executable and marks it autostart-enabled', () => {
    const entry = autostartEntry('/opt/Aria/aria-desktop');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Exec=/opt/Aria/aria-desktop');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
  });

  it('launches into the background so login never steals focus', () => {
    expect(autostartEntry('/opt/Aria/aria-desktop')).toContain(
      'Exec=/opt/Aria/aria-desktop --hidden',
    );
  });

  it('honours a custom background-launch argument', () => {
    expect(autostartEntry('/opt/Aria/aria-desktop', '--tray-only')).toContain(
      'Exec=/opt/Aria/aria-desktop --tray-only',
    );
  });
});

describe('autostart manager', () => {
  it('writes the entry when enabling', () => {
    const fs = fakeFs();
    const result = createAutostartManager({ directory, execPath: '/opt/Aria/aria-desktop', fs }).apply(
      true,
    );
    expect(result).toEqual({ ok: true, enabled: true, path });
    expect(fs.files.get(path)).toContain('Exec=/opt/Aria/aria-desktop');
  });

  it('threads the background-launch argument through to the written entry', () => {
    const fs = fakeFs();
    createAutostartManager({
      directory,
      execPath: '/opt/Aria/aria-desktop',
      hiddenLaunchArg: '--tray-only',
      fs,
    }).apply(true);
    expect(fs.files.get(path)).toContain('Exec=/opt/Aria/aria-desktop --tray-only');
  });

  it('removes the entry when disabling', () => {
    const fs = fakeFs({ [path]: autostartEntry('/opt/Aria/aria-desktop') });
    const result = createAutostartManager({ directory, execPath: '/opt/Aria/aria-desktop', fs }).apply(
      false,
    );
    expect(result).toEqual({ ok: true, enabled: false, path });
    expect(fs.files.has(path)).toBe(false);
  });

  it('reports failure instead of claiming the setting took', () => {
    const fs = fakeFs();
    fs.write = () => {
      throw new Error('read-only file system');
    };
    const result = createAutostartManager({ directory, execPath: '/opt/Aria/aria-desktop', fs }).apply(
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('read-only file system');
  });

  it('reports whether the entry is currently present', () => {
    const manager = createAutostartManager({
      directory,
      execPath: '/opt/Aria/aria-desktop',
      fs: fakeFs({ [path]: autostartEntry('/opt/Aria/aria-desktop') }),
    });
    expect(manager.isEnabled()).toBe(true);
  });
});
