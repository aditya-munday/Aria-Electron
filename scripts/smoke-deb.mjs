#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const skipInstall = args.includes('--no-install');
const bootMs = Number(readArg('--boot-ms') ?? 8000);
const exitMs = Number(readArg('--exit-ms') ?? 15000);

function readArg(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function findDeb() {
  const explicit = args.find((a) => a.endsWith('.deb'));
  if (explicit !== undefined) return explicit;
  const dir = 'release';
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.deb'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(dir, f))
    .pop();
}

function fail(message, detail) {
  process.stderr.write(`smoke-deb: ${message}\n`);
  if (detail !== undefined && detail !== '') process.stderr.write(`${detail}\n`);
  process.exit(1);
}

const deb = findDeb();
if (deb === undefined) fail('no .deb found under release/; run `npm run pack:deb` first');
if (!existsSync(deb)) fail(`package not found: ${deb}`);

if (!skipInstall) {
  // The package declares runtime library dependencies (libnotify, libxss). Use
  // apt so they are resolved and the postinst runs (it sets the chrome-sandbox
  // SUID bit); raw dpkg would leave the package unconfigured.
  const absolute = resolve(deb);
  let install = spawnSync('sudo', ['-n', 'apt-get', 'install', '-y', absolute], { encoding: 'utf8' });
  if (install.status !== 0) {
    install = spawnSync('sudo', ['-n', 'dpkg', '-i', absolute], { encoding: 'utf8' });
  }
  // dpkg unpacks the files even when it cannot configure the package because the
  // host lacks a declared library. The boot check below is the real gate, so a
  // non-zero status is only fatal when the binary never landed.
  if (install.status !== 0 && resolveBinary() === undefined) {
    fail(
      `installing ${deb} failed (status ${install.status})`,
      `${install.stdout ?? ''}${install.stderr ?? ''}`,
    );
  }
}

const bin = resolveBinary();
if (bin === undefined) fail('installed binary not found on PATH and not at /opt/Aria/aria-desktop');

// The binary living at /opt/Aria is not enough: the postinst must put it on
// PATH. A custom afterInstall that replaced electron-builder's default template
// and dropped its update-alternatives step installed the app but left the
// launcher missing, so `aria-desktop` printed "command not found". resolveBinary
// falls back to the /opt path, which would hide that, so require PATH explicitly.
if (!args.includes('--allow-missing-launcher') && spawnSync('which', ['aria-desktop'], { encoding: 'utf8' }).status !== 0) {
  fail('aria-desktop is not on PATH; the postinst did not create /usr/bin/aria-desktop');
}

// The smoke runs the real, sandboxed launch: no `--no-sandbox`. The SUID helper
// the package ships must be usable (root-owned 4755) or the kernel must allow
// unprivileged user namespaces, otherwise Chromium would either abort or — worse
// — silently fall back. This asserts the strong posture instead of assuming it.
if (!args.includes('--allow-unconfigured-sandbox') && !sandboxUsable()) {
  fail(
    'the sandbox is not usable: /opt/Aria/chrome-sandbox is not root-owned mode 4755 ' +
      'and unprivileged user namespaces are unavailable. Install the package with a ' +
      'package manager so its postinst sets the bit, or pass --allow-unconfigured-sandbox.',
  );
}

const env = {
  ...process.env,
  ARIA_BACKEND_URL: process.env.ARIA_BACKEND_URL ?? 'http://127.0.0.1:9',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
};

const { command, launchArgs } = launcher(bin);

const child = spawn(command, launchArgs, {
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));

let exited = false;
let exitCode = null;
let exitSignal = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
});

// Liveness must be observed over real time: a crashed process exits on its own
// before the first timer fires, so polling synchronously would report a boot
// that never happened.
const bootDeadline = Date.now() + bootMs;
while (!exited && Date.now() < bootDeadline) {
  await delay(200);
}
if (exited) {
  fail(`the app exited during boot (code ${exitCode}, signal ${exitSignal})`, [stdout, stderr].join('\n'));
}

// A live process is not a working app: the renderer can fail to load (a bad
// asar path, a fuse that blocks file://) and the main process keeps running
// with a blank window. The Control Center load failure is reported on stderr,
// so a boot that logs one has not actually come up.
const rendererFailure = /renderer:[a-z_]+:/.exec(`${stdout}\n${stderr}`);
if (rendererFailure !== null) {
  fail(`the renderer failed to load (${rendererFailure[0]})`, [stdout, stderr].join('\n'));
}

const cleanExit = await terminate(child, exitMs);
if (!cleanExit) {
  fail(`the app did not exit within ${exitMs} ms after SIGTERM`, [stdout, stderr].join('\n'));
}
if (exited === false) fail('process still alive after terminate');

process.stdout.write(`smoke-deb: ok (${deb})\n`);
process.exit(0);

function resolveBinary() {
  const which = spawnSync('which', ['aria-desktop'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.trim();
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'aria-desktop');
    if (existsSync(candidate)) return candidate;
  }
  return existsSync('/opt/Aria/aria-desktop') ? '/opt/Aria/aria-desktop' : undefined;
}

/**
 * Whether Chromium's sandbox can engage: either the SUID helper is root-owned
 * mode 4755, or the kernel allows unprivileged user namespaces (an `unshare`
 * of a user namespace succeeds).
 */
function sandboxUsable() {
  const helper = '/opt/Aria/chrome-sandbox';
  if (existsSync(helper)) {
    const stat = spawnSync('stat', ['-c', '%u %a', helper], { encoding: 'utf8' });
    if (stat.status === 0 && stat.stdout.trim() === '0 4755') return true;
  }
  const unshare = spawnSync('unshare', ['--user', 'true'], { encoding: 'utf8' });
  return unshare.status === 0;
}

/** Pick the launcher: a virtual X server when available, else Ozone headless. */
function launcher(bin) {
  const hasXvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0;
  if (hasXvfb) return { command: 'xvfb-run', launchArgs: ['-a', bin] };
  const hasX = existsSync('/tmp/.X11-unix') || (process.env.DISPLAY ?? '') !== '';
  if (hasX) return { command: bin, launchArgs: [] };
  return { command: bin, launchArgs: ['--ozone-platform=headless', '--disable-gpu'] };
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 200);
    };
    // Defer the first check so the process has real time to react to a signal.
    setTimeout(tick, 200);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminate(proc, timeoutMs) {
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill('SIGTERM');
  }
  return waitFor(() => proc.exitCode !== null || proc.signalCode !== null, timeoutMs);
}
