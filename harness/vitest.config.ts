import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The same aliases as tsconfig: one @sc/api, and the adapter the app ships, both from source.
const source = (path: string) => fileURLToPath(new URL(`../../streaming_center_app/adapters/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sc/api': source('api/src/index.ts'),
      '@sc/sync-custom-server': source('sync/custom-server/src/index.ts'),
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
