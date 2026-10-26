import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@rnpa\/shared$/, replacement: src('./packages/shared/src/index.ts') },
      { find: /^@rnpa\/shared\/(.*)$/, replacement: src('./packages/shared/src/$1.ts') },
      { find: /^@rnpa\/analyzer$/, replacement: src('./packages/analyzer/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    environment: 'node',
  },
});
