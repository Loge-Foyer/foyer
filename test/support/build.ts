import { execFileSync } from 'node:child_process';

// The crash and command-line tests run the bundle the image ships, so build it first.
export default function setup() {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
}
