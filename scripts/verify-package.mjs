#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A packaged build must not ship the material that makes reverse engineering
// trivial: source maps, TypeScript declarations, or test sources. This runs
// against the real asar inside the built app so a regression fails the gate.
const unpacked = 'release/linux-unpacked/resources/app.asar';
if (!existsSync(unpacked)) {
  process.stderr.write(`verify-package: ${unpacked} not found; run \`npm run pack:deb\` first\n`);
  process.exit(1);
}

const listing = execFileSync('npx', ['asar', 'list', unpacked], { encoding: 'utf8' }).split('\n');
const offenders = listing.filter((p) => /\.(map|d\.ts)$/.test(p) || /\.ts$/.test(p));

if (offenders.length > 0) {
  process.stderr.write('verify-package: reverse-engineering surface shipped:\n');
  for (const offender of offenders.slice(0, 40)) process.stderr.write(`  ${offender}\n`);
  process.exit(1);
}

const preload = listing.filter((p) => /preload\.cjs$/.test(p));
if (preload.length !== 1) {
  process.stderr.write(`verify-package: expected exactly one bundled preload, found ${preload.length}\n`);
  process.exit(1);
}

// The voice sidecar ships outside the asar as an extra resource. When it is
// present it must be executable and match the checksum recorded at build time;
// a build that skips the sidecar (no `uv`) leaves it absent, which the app
// reports truthfully rather than shipping a broken binary.
const sidecarBinary = 'release/linux-unpacked/resources/sidecar/aria-voice/aria-voice';
if (existsSync(sidecarBinary)) {
  const digest = createHash('sha256').update(readFileSync(sidecarBinary)).digest('hex');
  const sumFile = 'release/linux-unpacked/resources/sidecar/aria-voice/aria-voice.sha256';
  const expected = existsSync(sumFile) ? readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0] : '';
  if (expected === '' || digest !== expected) {
    process.stderr.write(
      `verify-package: sidecar checksum mismatch (packaged ${digest.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)\n`,
    );
    process.exit(1);
  }
  process.stdout.write('verify-package: sidecar present and checksum verified\n');
}

process.stdout.write(`verify-package: ok (${listing.length} entries, no maps, no declarations)\n`);
