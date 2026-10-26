// Bundles the agent twice:
//  - dist/prelude.js: self-contained IIFE injected ahead of an app's JS bundle.
//  - dist/index.js:   ESM SDK for apps that integrate the agent directly.
// Both target ES2017 and avoid syntax that older Hermes/JSC builds reject.
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';

const common = {
  bundle: true,
  target: 'es2017',
  platform: 'neutral',
  legalComments: 'none',
  logLevel: 'warning',
  supported: { 'class-field': false, 'class-static-field': false },
};

await build({ ...common, entryPoints: ['src/prelude.ts'], outfile: 'dist/prelude.js', format: 'iife', minify: true });
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'esm', external: ['react-native'] });

// Hermes (pre-0.12) cannot compile ES classes or async functions from source.
const prelude = readFileSync('dist/prelude.js', 'utf8');
const forbidden = [/\bclass\s+[A-Za-z_$][\w$]*\s*(extends\b[^{]*)?\{/, /\basync\s+function\b/, /\basync\s*\(/, /\bawait\s/];
for (const pattern of forbidden) {
  if (pattern.test(prelude)) {
    console.error(`prelude contains unsupported syntax: ${pattern}`);
    process.exit(1);
  }
}
console.log(`prelude.js ${(statSync('dist/prelude.js').size / 1024).toFixed(1)} KB`);
