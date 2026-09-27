import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The same alias as tsconfig and the build: one @sc/api, from its source.
const api = fileURLToPath(new URL('../streaming_center_plugins/api/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@sc/api': api } },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/build.ts'],
    // node:sqlite warns that it is experimental.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
