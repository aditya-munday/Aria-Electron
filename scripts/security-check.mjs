#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// Security regressions this gate refuses to let through: a downgraded Electron,
// a production dependency advisory, a weakened renderer CSP, or a flipped
// Electron fuse. The renderer pages load from the privileged `app://` scheme, so
// `grantFileProtocolExtraPrivileges` must stay off.

// Electron is a devDependency but it ships inside the .deb, so `npm audit
// --omit=dev` never sees it. This floor is bumped whenever the runtime is
// upgraded; it exists so a downgrade to an advisory-affected release fails CI.
const MIN_ELECTRON_MAJOR = 40;

const failures = [];

function compareMajor(version) {
  return Number.parseInt(version.replace(/^[^0-9]*/, '').split('.')[0], 10);
}

const electronPkg = JSON.parse(
  readFileSync(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8'),
);
if (compareMajor(electronPkg.version) < MIN_ELECTRON_MAJOR) {
  failures.push(
    `electron ${electronPkg.version} is below the supported floor ${MIN_ELECTRON_MAJOR}.x`,
  );
}

// Every fuse must hold its required value. A regression here is a silent
// weakening of the sandbox, so the build fails rather than trusting a comment.
const REQUIRED_FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fuses = pkg.build?.electronFuses ?? {};
for (const [fuse, expected] of Object.entries(REQUIRED_FUSES)) {
  if (fuses[fuse] !== expected) {
    failures.push(`electron fuse ${fuse} must be ${expected} (found ${String(fuses[fuse])})`);
  }
}

try {
  execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { stdio: 'pipe' });
} catch (error) {
  failures.push(`production dependency audit failed:\n${error.stdout?.toString() ?? error.message}`);
}

const rendererHtml = [
  'dist/renderer/control-center.html',
  'dist/renderer/orb.html',
  'dist/renderer/chat.html',
  'dist/renderer/voice.html',
];
for (const file of rendererHtml) {
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  if (!/Content-Security-Policy/.test(html)) failures.push(`${file} has no CSP meta tag`);
  if (/'unsafe-eval'/.test(html)) failures.push(`${file} allows 'unsafe-eval'`);
  if (/default-src\s+(?!'none')/.test(html)) failures.push(`${file} does not default-src 'none'`);
}

if (failures.length > 0) {
  process.stderr.write('security-check: refused\n');
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `security-check: ok (electron ${electronPkg.version}, prod deps clean, CSP intact)\n`,
);
