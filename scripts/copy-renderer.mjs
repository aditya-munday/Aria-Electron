import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src', 'renderer');
const target = join(root, 'dist', 'renderer');

// Only static assets ship. A stray TypeScript or test file copied here would end
// up readable inside the shipped asar, so it is pruned after the copy.
function prune(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      prune(full);
      continue;
    }
    if (/\.(ts|map)$/.test(entry)) rmSync(full);
  }
}

if (existsSync(source)) {
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  prune(target);
}
