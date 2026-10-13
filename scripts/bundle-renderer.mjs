import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const entries = [
  ['src/control-center/renderer/control-center.ts', 'control-center.js'],
  ['src/orb/renderer/orb.ts', 'orb.js'],
  ['src/chat/renderer/chat.ts', 'chat.js'],
];

for (const [entry, out] of entries) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, 'dist', 'renderer', out),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
}

// The preload runs inside the sandbox, where `require` exists but bare-module
// resolution does not. It is bundled to a single CommonJS file that only
// requires `electron`, so the sandbox never needs a module loader.
await build({
  entryPoints: [join(root, 'src', 'preload.ts')],
  outfile: join(root, 'dist', 'preload.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node20'],
  external: ['electron'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});