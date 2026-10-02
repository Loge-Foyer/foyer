# AGENTS.md — foyer

Your own server: PocketBase, used as a Go framework. Read the workspace root
`AGENTS.md` and `../.claude/architecture.md` first — §7 (the
account role), §9 (syncing with your own server), §10 (conflicts) and §17
(your own server).

`docs/protocol` is what the client speaks; `docs/api` is every route,
collection and rule.

---

## What this is

A small server a household runs itself as its **account**: its profiles, their
PINs and preferences, and its source and IPTV connections with their
passwords, kept in step between its devices. Several accounts can share one
server, each with up to `FOYER_MAX_PROFILES` profiles.

It is the other end of the `sync/custom-server` adapter, which lives in
`../loge/adapters/sync/custom-server`. The adapter is the
client; this is PocketBase, with the app's collections, rules and hooks.

## What this is not

- **Not a media server.** It never stores or streams video, or artwork.
- **Not required.** A device's account can be local. iCloud, Google Drive and
  OneDrive keep a backup file, not an account.
- **Not where Jellyfin's watch status goes.** A media server masters its own;
  the app reads it and writes it back through that source's media role.
- **Not a place for what belongs to a device.** Players, sync settings — this
  server's own sign-in among them — the default profile, sessions and caches
  never reach it. `plugin_id` takes `sources/*`, `iptv/*` and `metadata/*`
  only.

## Boundaries

- **PocketBase and Go. Nothing from TypeScript.** Go cannot import `@loge/api`,
  and nothing the server ships touches it.
- **`api` states the contract.** `api/src/account.ts` is the record contract,
  and `api/fixtures/account-records.json` holds both sides to it: the api's
  tests and the Go tests read the same file. Change them together — the
  contract in `../loge/adapters/api` first, then the
  collections and hooks here. `internal/fixtures/fixtures.go` reads that file
  by relative path, so it breaks loudly if either side moves.
- **One exception, test-only:** `harness/` (Node, vitest) builds the binary and
  drives the real `sync/custom-server` adapter, aliased to its source, against
  it. `harness/AGENTS.md` states the exception. Nothing else here is
  TypeScript, and nothing in `harness/` ships.
- **Never the app.**

## What the server promises

The client's reconciliation (`docs/protocol`) rests on these:

1. **Every user sees all of its own records, and nobody else's.** The rules
   are `user = @request.auth.id`; a write names its own user, and an update
   never moves a record to another.
2. **A guest sees nothing.** Without a valid session, account data answers
   `401` — never an empty list, which would read as a server that lost
   everything.
3. **Deletes are soft**, the tombstone cleared of its payload, secrets
   included — and final for profiles and connections.
4. **The profile limit:** no new live profile beyond `FOYER_MAX_PROFILES`.
5. **No hard deletes of account data**, but the cascade when a user is deleted.
6. **A batch is all or nothing**, and a refusal names the write that stopped
   it.
7. **A listed secret a write lacks keeps its stored value.**
8. **A password change ends every session.**
9. **`info` answers without a session.**

## What it must never do

- **Resolve conflicts.** The client owns that: a pending change first, deletes
  of profiles and connections always, otherwise the last push, whole. The
  server stores what the rules allow and returns it. It never merges two
  writes, and never picks a winner by `updated` or anything else.
- **Accept account data outside the owner's rules** — for another user, from a
  guest, or for a device-wide plugin.
- **Lock an account from everywhere.** PocketBase's limiter counts per address,
  in memory. Never add a count per username: anyone who knows one could keep
  its owner out.
- **Store media.**
- **Open a browser.** PocketBase opens a tab to make the first superuser
  whenever `serve` starts without one — on whoever started it, and once per
  test in the harness. `Bind` turns its installer off; the superuser comes
  from `FOYER_ADMIN_*` or `superuser upsert`. A test app skips the installer
  by itself, so the test that holds this arms it again first.

## Skills

`.agents/skills/` in this repository:

- **`foyer-sync-protocol`** — the account protocol on the server: the collections
  and their rules, the hooks, the two routes, migrations, and what must stay
  true for the client's reconciliation.

---

## Shape

```
main.go              .env, then pocketbase.New(); migratecmd, automigrate off; server.Bind; the invite command
go.mod               PocketBase pinned to v0.40.4, which needs Go 1.27
internal/config/     FOYER_MAX_PROFILES, FOYER_SIGNUP, FOYER_ADMIN_*, FOYER_TRUST_PROXY, and the .env reader; the old SC_* names refused
internal/records/    the kinds and their collections, the derived id, Validate — isAccountRecord's judgement
internal/hooks/      no guests, every write judged, the profile limit, deleted stays deleted, tombstones, no hard deletes, kept secrets
internal/routes/     GET /api/foyer/info, POST /api/foyer/sign-up
internal/version/    the version, always the app's: its `npm run release` moves both
internal/invites/    codes, their hashes, and the invite command
internal/server/     Bind: the hooks, the routes, the trusted proxy and no installer — and the HTTP tests
internal/fixtures/   test-only: the shared fixtures, written as the plugin sends them
migrations/          1 the collections and rules; 2 users; 3 batch and rate limits; 4 the superuser; 5 subscriptions and playlists; 6 favourite channels; 7 watch progress and the account's settings; 8 Foyer's name, and the sign-up rule's label
harness/             Node + vitest, test-only: the real plugin against the real binary
Dockerfile           two stages: a Go build, then the binary alone
docker-compose.yml   the server, and pb_data in a volume
```

Go tests sit beside what they test. Everything else is PocketBase's: `serve`,
`superuser`, `migrate`, users and sessions, the record APIs, `/api/batch`, the
dashboard at `/_/`, backups and the rate limiter.


## Rules that break silently

- **PocketBase takes a bad token for a guest.** A missing, expired or invalid
  token is no error to it: the request goes on as a guest, and under the owner
  rules a guest's list is empty. The no-guests hook turns that into `401`.
  Without it, a device whose session ended mid-sync reads an empty account,
  takes the server for restored, and uploads its own copy over newer edits.
- **Migrations are numbered, and never edited once shipped.** A server that
  ran one never runs it again: fix forward with a new one. Automigrate stays
  off, and nobody changes the collections in the dashboard — a field added
  there exists on one server only, and a rule loosened there opens the data.
- **A new field is optional.** An older app never sends it; made required, it
  refuses every write from one.
- **The batch holds the largest push**, a whole local account uploaded at
  sign-up. PocketBase's defaults are 50 requests in 3 seconds, and a batch
  over them fails without naming a write, which the client cannot act on.
- **The server clears a tombstone.** An upsert updates only the fields it
  carries, so a `deleted: true` that left `secrets` behind would keep a
  password in a record nobody reads.
- **The first profile's id.** The sign-up route derives it as the plugin does.
  Otherwise a device's first rename writes a second record under the same key,
  and the unique `(user, key)` index refuses it.
- **The hooks hold for superusers.** The dashboard is a client of the same
  API: a record deleted there would read as lost and come back from the
  devices.
- **The names from before Foyer are refused.** `SC_MAX_PROFILES` and the rest
  became `FOYER_…`. Read silently, an old `.env` would drop its profile limit
  and its proxy header, so `FromEnv` refuses to start and names the new one.
- **`FOYER_TRUST_PROXY` only behind a proxy.** Without one, anyone can claim any
  address and slip the limiter. Behind one without it, every caller has the
  proxy's address, and one stranger's tries throttle the whole household.
- **Two kinds of user.** PocketBase's `users` are accounts; the app's users are
  profiles. A record's `user` is its account, and its `profile` its profile.
- **Nothing decides by `created` or `updated`.** If a collection has them, they
  are for people reading the dashboard.
- **PocketBase is pinned.** It is pre-1.0, and minor versions break its Go API.
  Update deliberately, one version at a time, with the Go tests.

## Current state

**Phase 6 — the server runs.** PocketBase v0.40.4, used as a Go framework:
the account's collections and their rules, the hooks, `info` and `sign-up`,
and the `invite` command. `go test ./...` proves it — the rules, sign-up and
invites, the hooks, batches, sessions and the shared fixtures. The app's
`sync/custom-server` plugin speaks it, and the harness drives that very plugin
against the real binary: sign-up and sign-in, the rules, the owner check, a
password changed elsewhere, a session that ended, signing out, and
throttling. The Dockerfile and compose file are written, and not yet built:
Docker was not there.
