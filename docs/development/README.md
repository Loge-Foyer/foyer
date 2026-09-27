# Development

```bash
cd ../streaming_center_plugins && npm install   # @sc/api is read from its source there
cd ../streaming_center_sync && npm install
npm run dev          # tsx, restarting on changes; data in ./data
npm run typecheck
npm test             # builds dist/ first, then every suite
npm run build        # dist/main.mjs and dist/cli.mjs, each one file
npm start            # the bundle, as the image runs it
npm run sc-sync -- invite
```

`@sc/api` is never installed. `tsconfig.json`, `vitest.config.ts` and
`scripts/build.mjs` alias it to `../streaming_center_plugins/api/src`: one copy,
and the server checks pushes with the client's own `isSyncChange`. The server
depends on nothing else from the project.

The tests alias one more: `@sc/plugin-custom-server`, the real client, for
`plugin.test.ts` alone. Nothing in `src/` imports it — a test checks — so it
never reaches the bundle.

## Tests

- **`store.test.ts`** — the database and the log, on a real SQLite file:
  migrations and a newer database refused; a push stored once however often it
  is sent; the prefix ending at a refused change; a storage error accepting
  nothing, and the resend stored once; unknown fields kept; pages, the byte
  limit, cursors surviving a restart; `reset` for another epoch, a position
  past the end, and a log put back from an older copy.
- **`auth.test.ts`** — parameters that do not tell whether a name exists; sign-in
  right and wrong; one device row per installation; no token or proof in the
  database; revoking; each throttle bucket, and that no address can lock the
  owner out from another; verify; invites once, expiring, checked before the
  name.
- **`http.test.ts`** — CORS, limits, errors, and the log over HTTP: own changes
  returned, sealed values and unknown fields carried exactly, a storage failure
  answering 503.
- **`crash.test.ts`** — the bundle as its own process, killed where a push is
  most fragile: before its commit, and after it but before the answer. Every
  change a device was told was stored is there once, in order, and the resend
  duplicates nothing. The crash points (`SC_SYNC_CRASH`) work only with
  `SC_SYNC_TEST_HOOKS=1`.
- **`cli.test.ts`** — invites, accounts, devices, revoking, deleting, and a
  backup restored over a stale write-ahead log, after which every earlier
  cursor answers `reset`; no restore under a server here, or under one in
  another container.
- **`plugin.test.ts`** — the real `custom-server` plugin against the real
  server, in-process, over a Node host with `node:crypto` (`support/host.ts`)
  and real key derivation: an account created from an invite, a second device
  with the same vault key, two devices in one order, a sealed value carried
  exactly, the owner check right, wrong and throttled, `sc-sync revoke` ending
  a device that never signs itself back in, and signing out.

The app's tests prove the client side of the same protocol, two devices at a
time, against a fake account.
