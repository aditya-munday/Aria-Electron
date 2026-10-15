import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8');
}

/**
 * `deb.afterInstall` / `deb.afterRemove` replace electron-builder's default
 * templates wholesale, so a script that forgets a default step silently ships a
 * broken package. Both regressions this guards against reached a user: a
 * postinst with no `update-alternatives` step installed the app but left
 * `aria-desktop` off `PATH` ("command not found"), and one with no sandbox step
 * left Chromium aborting at launch. Assert the steps the default template
 * performs are present.
 */
describe('deb maintainer scripts', () => {
  it('keeps the launcher, sandbox and AppArmor steps in after-install', () => {
    const script = read('build/linux/after-install.sh');
    expect(script).toContain('update-alternatives --install');
    expect(script).toContain('chmod 4755');
    expect(script).toContain('apparmor_parser');
    expect(script).toContain('update-desktop-database');
  });

  it('undoes the launcher and AppArmor profile in after-remove', () => {
    const script = read('build/linux/after-remove.sh');
    expect(script).toContain('update-alternatives --remove');
    expect(script).toContain('apparmor_parser --remove');
  });

  it('wires both scripts into the deb target', () => {
    const pkg = JSON.parse(read('package.json')) as {
      build: { deb: { afterInstall?: string; afterRemove?: string } };
    };
    expect(pkg.build.deb.afterInstall).toBe('build/linux/after-install.sh');
    expect(pkg.build.deb.afterRemove).toBe('build/linux/after-remove.sh');
  });
});
