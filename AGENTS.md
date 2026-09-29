# AGENTS.md — streaming_center_sync

Your own server: PocketBase, used as a Go framework. Read the workspace root
`AGENTS.md` and `../.claude/streaming-center-architecture.md` first — §7 (the
account role), §9 (syncing with your own server), §10 (conflicts) and §17
(your own server).

`docs/protocol` is what the client speaks; `docs/api` is every route,
collection and rule.

---

## What this is

A small server a household runs itself as its **account**: its profiles, their
PINs and preferences, and its source and IPTV connections with their
passwords, kept in step between its devices. Several accounts can share one
server, each with up to `SC_MAX_PROFILES` profiles.

It is the other end of the `sync/custom-server` plugin in
`streaming_center_plugins`. The plugin is the client; this is PocketBase, with
the app's collections, rules and hooks.

## What this is not

- **Not a media server.** It never stores or streams video, or artwork.
- **Not required.** A device's account can be local. iCloud, Google Drive and
  OneDrive keep a backup file, not an account.
- **Not where Jellyfin's watch status goes.** A media server masters its own;
  the app reads it and writes it back through that source's media role.
- **Not a place for what belongs to a device.** Players, sync settings — this
  server's own sign-in among them — the default profile, sessions and caches
  never reach it. `plugin_id` takes `sources/*` and `iptv/*` only.

## Boundaries

- **PocketBase and Go. Nothing from TypeScript.** Go cannot import `@sc/api`,
  and nothing the server ships touches it.
- **`api` states the contract.** `api/src/account.ts` is the record contract,
  and `api/fixtures/account-records.json` holds both sides to it: the api's
  tests and the Go tests read the same file. Change them together — the
  contract in the plugins repository first, then the collections and hooks
  here.
- **One exception, test-only:** `harness/` (Node, vitest) builds the binary and
  drives the real `sync/custom-server` plugin, aliased to its source, against
  it. `harness/AGENTS.md` (Phase 6) states the exception. Nothing else here is
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
4. **The profile limit:** no new live profile beyond `SC_MAX_PROFILES`.
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

## Skills

`.agents/skills/` in this repository:

- **`sc-sync-protocol`** — the account protocol on the server: the collections
  and their rules, the hooks, the two routes, migrations, and what must stay
  true for the client's reconciliation.

---

## Shape

```
main.go              pocketbase.New(); migratecmd, automigrate off; the hooks, the routes, the invite command
go.mod               PocketBase pinned to v0.40.x, which needs Go 1.27
internal/config/     SC_MAX_PROFILES, SC_SIGNUP, SC_ADMIN_*, SC_TRUST_PROXY
internal/hooks/      no guests, the profile limit, deleted stays deleted, tombstones, no hard deletes, kept secrets
internal/routes/     GET /api/sc/info, POST /api/sc/sign-up
migrations/          numbered: the collections and rules; users; batch, rate limits, proxy; the superuser
harness/             Node + vitest, test-only: the real plugin against the real binary
Dockerfile           two stages: a Go build, then the binary alone
docker-compose.yml   the server, and pb_data in a volume
```

Go tests sit beside what they test. Everything else is PocketBase's: `serve`,
`superuser`, `migrate`, users and sessions, the record APIs, `/api/batch`, the
dashboard at `/_/`, backups and the rate limiter.

**Transitional:** until Phase 6 this repository holds Phase 4's TypeScript
server — `src/`, `test/`, `scripts/build.mjs`, a Node Dockerfile — and
`npm start` runs it. Everything here describes the Go layout that replaces it.

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
- **`SC_TRUST_PROXY` only behind a proxy.** Without one, anyone can claim any
  address and slip the limiter. Behind one without it, every caller has the
  proxy's address, and one stranger's tries throttle the whole household.
- **Two kinds of user.** PocketBase's `users` are accounts; the app's users are
  profiles. A record's `user` is its account, and its `profile` its profile.
- **Nothing decides by `created` or `updated`.** If a collection has them, they
  are for people reading the dashboard.
- **PocketBase is pinned.** It is pre-1.0, and minor versions break its Go API.
  Update deliberately, one version at a time, with the Go tests.

## Current state

**Phase 5 — the new architecture, written down.** Until Phase 6 replaces it,
this repository still holds the TypeScript server from Phase 4: Node 24, Hono,
one SQLite file, one log per account, `sc-sync`, port 8730. Its suites pass
(`npm run typecheck && npm test`), today's `custom-server` plugin speaks its
protocol, and nothing of the Go server exists yet. Phase 6 builds it and
deletes the TypeScript.
