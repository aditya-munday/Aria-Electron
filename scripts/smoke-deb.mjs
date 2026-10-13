#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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
    .map((f) => join(dir, f))
    .sort()
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
  const install = spawnSync('sudo', ['-n', 'dpkg', '-i', deb], { encoding: 'utf8' });
  if (install.status !== 0) {
    fail(
      `dpkg -i ${deb} failed (status ${install.status})`,
      `${install.stdout ?? ''}${install.stderr ?? ''}`,
    );
  }
}

const bin = resolveBinary();
if (bin === undefined) fail('installed binary not found on PATH and not at /opt/Aria/aria-desktop');

const env = {
  ...process.env,
  ARIA_BACKEND_URL: process.env.ARIA_BACKEND_URL ?? 'http://127.0.0.1:9',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
};

const child = spawn('xvfb-run', ['-a', bin, '--no-sandbox'], {
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
