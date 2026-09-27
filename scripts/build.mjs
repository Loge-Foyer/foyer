// Bundles the server and its command line into dist/, each one file with its
// dependencies and @sc/api inside: Node runs them with nothing installed.
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const api = fileURLToPath(new URL('../../streaming_center_plugins/api/src/index.ts', import.meta.url));

await build({
  entryPoints: { main: 'src/main.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  alias: { '@sc/api': api },
  // Some dependencies still reach for require(); give the bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
