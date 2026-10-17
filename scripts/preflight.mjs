#!/usr/bin/env node
// Pre-release checklist. Six 0.7.x releases in three days each fixed a
// packaging or startup regression that a checklist would have caught, so this
// gate asserts the release invariants before a tag is cut:
//   - the version is consistent across package.json, the sidecar and CHANGELOG;
//   - the licence placeholder and third-party notices exist;
//   - the release workflow and docs the release relies on are present.
// It reads files only, so it is cheap enough to run on every release and in CI.

import { readFileSync, existsSync } from 'node:fs';

const failures = [];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const requireFile = (path, why) => {
  if (!existsSync(new URL(`../${path}`, import.meta.url))) failures.push(`${path} is missing (${why})`);
};

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;

const sidecarVersion = read('sidecar/pyproject.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (sidecarVersion !== version) {
  failures.push(`sidecar/pyproject.toml version ${sidecarVersion} != package.json ${version}`);
}

const changelog = read('CHANGELOG.md');
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  failures.push(`CHANGELOG.md has no "## [${version}]" section`);
}

requireFile('LICENSE', 'licence placeholder');
requireFile('THIRD_PARTY_NOTICES.md', 'third-party notices');
requireFile('docs/VOICE_SIDECAR.md', 'sidecar protocol');
requireFile('docs/WAKE_WORD.md', 'wake-word tuning');
requireFile('.github/workflows/release.yml', 'release workflow');
requireFile('scripts/verify-package.mjs', 'packaging verification');

// The packaged app must not claim a wake word it cannot deliver: the shipped
// default engine has to be the dependency-free one, or a stock host with no
// sidecar would have no working wake word.
if (!/in-process JavaScript detector/.test(read('src/voice/voice-runtime.ts'))) {
  failures.push('voice-runtime.ts no longer documents the in-process default engine');
}

if (failures.length > 0) {
  process.stderr.write('preflight: refused\n');
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`preflight: ok (aria-desktop ${version}, docs and notices present)\n`);
