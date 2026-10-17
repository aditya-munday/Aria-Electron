#!/usr/bin/env node
// Build the Python voice sidecar into a self-contained executable with
// PyInstaller, then stage it (with a checksum) where electron-builder picks it
// up as an extra resource.
//
// The sidecar is opt-in (`ARIA_WAKE_ENGINE=sidecar`), but when it is requested
// it must work on a stock host with no Python and no `uv`. A host without `uv`
// (or a build machine that skips this step) is a hard failure when
// `ARIA_BUILD_SIDECAR=required`, and a warning otherwise, so a developer build
// is not blocked by a missing toolchain.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sidecar = join(root, 'sidecar');
const distDir = join(sidecar, 'dist', 'aria-voice');
const staged = join(root, 'build', 'sidecar');

function have(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!have('uv', ['--version'])) {
  const message = 'build-sidecar: `uv` is not installed; cannot build the sidecar';
  if (process.env.ARIA_BUILD_SIDECAR === 'required') {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  // Leave an (empty) staged directory so electron-builder's extraResources does
  // not fail on a missing source; the app then truthfully reports the sidecar
  // as unavailable and the in-process detector remains the engine.
  mkdirSync(staged, { recursive: true });
  process.stdout.write(`${message} (skipping)\n`);
  process.exit(0);
}

process.stdout.write('build-sidecar: building the aria-voice executable…\n');
execFileSync(
  'uv',
  ['run', '--project', sidecar, '--group', 'build', 'pyinstaller', '--clean', '--noconfirm', 'aria-voice.spec'],
  { cwd: sidecar, stdio: 'inherit' },
);

if (!existsSync(join(distDir, 'aria-voice'))) {
  process.stderr.write(`build-sidecar: expected ${distDir}/aria-voice was not produced\n`);
  process.exit(1);
}

rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
cpSync(distDir, join(staged, 'aria-voice'), { recursive: true });

const binary = join(staged, 'aria-voice', 'aria-voice');
const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
// The checksum ships beside the binary so verify-package can confirm the
// packaged executable is the one that was built.
writeFileSync(join(staged, 'aria-voice', 'aria-voice.sha256'), `${digest}  aria-voice\n`);
process.stdout.write(`build-sidecar: staged at build/sidecar/aria-voice (sha256 ${digest.slice(0, 12)}…)\n`);
