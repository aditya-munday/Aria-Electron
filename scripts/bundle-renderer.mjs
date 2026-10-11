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
    logLevel: 'warning',
  });
}