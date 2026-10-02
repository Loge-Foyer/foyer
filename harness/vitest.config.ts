import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The same aliases as tsconfig: one @loge/api, and the adapter the app ships, both from source.
const source = (path: string) => fileURLToPath(new URL(`../../loge/adapters/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@loge/api': source('api/src/index.ts'),
      '@loge/sync-custom-server': source('sync/custom-server/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/build.ts'],
    // Each test starts a server of its own; building the binary is done once, before any of them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
