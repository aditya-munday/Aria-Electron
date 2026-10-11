import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, 'src', 'control-center', 'renderer', 'control-center.ts')],
  outfile: join(root, 'dist', 'renderer', 'control-center.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  logLevel: 'warning',
});