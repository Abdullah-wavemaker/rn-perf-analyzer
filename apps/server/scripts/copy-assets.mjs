// Copies the built dashboard next to the compiled server so `dist/` is self-contained.
import { cpSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = join(here, '..', '..', 'dashboard', 'dist');
const target = join(here, '..', 'dist', 'public');

rmSync(target, { recursive: true, force: true });
if (existsSync(join(dashboard, 'index.html'))) {
  cpSync(dashboard, target, { recursive: true });
  console.log('Copied dashboard into dist/public');
} else {
  console.warn('Dashboard build not found; run `npm run build -w @rnpa/dashboard` first.');
}
chmodSync(join(here, '..', 'dist', 'cli.js'), 0o755);
