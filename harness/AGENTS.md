# AGENTS.md — harness/

**The one exception to "nothing here is TypeScript".** This folder is Node
and vitest, test-only, and nothing in it ships: not in the binary, not in the
image (`.dockerignore` leaves it out).

It exists because Go cannot import `@sc/api`. The shared fixtures keep the
record contract in step; this keeps the *plugin* in step: the real
`sync/custom-server`, the one the app ships, against the real binary.

## How it works

- `test/support/build.ts` builds the binary once per run (`go build`), in a
  temporary directory.
- `test/support/server.ts` starts it for each test on a temporary data
  directory and a free port, with an environment of its own — nothing from
  your shell's `SC_*` — so every test starts with no accounts and a fresh
  rate limiter. `invite` and `superuser` are the binary's own commands.
- `test/support/host.ts` is a device as far as a plugin can tell: the app's
  host context rebuilt on Node — `fetch`, node:crypto, a session store that
  outlives a provider — with every exchange recorded, so a test can count the
  sign-ins.
- `@sc/api` and the plugin are aliased to their source in
  `../../streaming_center_plugins` (`vitest.config.ts`, `tsconfig.json`),
  never installed.

## Rules

- **Never import the app.** The plugin, through its public `plugin` export,
  and `@sc/api`: nothing else.
- **Never reach into the plugin's internals** — its session format, its
  record ids. What the harness checks is what a device would see.
- **Mind the rate limits.** They are on, as in production: five password
  sign-ins a minute from one address, the dashboard's included. Each test has
  its own server; keep a test under that, or make throttling its subject.
- **The Go tests prove the server; this proves the pair.** A rule belongs in
  the Go tests first. Add a scenario here when the plugin and the server could
  disagree about it.

## Run

```bash
npm install
npm run typecheck
npm test          # builds the binary, then every scenario against it
```
