import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A clean dist is a security control: a stale build can otherwise leave source
// maps or declarations from an earlier configuration inside the shipped asar.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(root, 'dist'), { recursive: true, force: true });
