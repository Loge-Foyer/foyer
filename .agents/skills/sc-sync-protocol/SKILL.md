---
name: sc-sync-protocol
description: The account protocol on the server side — the PocketBase collections and their owner rules, the hooks (no guests, the profile limit, deleted stays deleted, no hard deletes, tombstones cleared, listed secrets kept), the two routes, migrations, and what must stay true for the client's reconciliation. Use when adding or changing a collection, field, rule, hook, route or migration in the sync server, or when debugging what a device reads or pushes.
---

# The account protocol, server side

Read `../.claude/streaming-center-architecture.md` §7 (the account role), §9
(syncing with your own server), §10 (conflicts) and §17 (your own server);
then `docs/protocol/README.md`, the protocol as the client speaks it, and
`docs/api/README.md`. The server is the other end of `ConnectedAccount` in
`api/src/account.ts`.

## When to use it

- adding or changing a collection, a field, a rule or an index
- writing or changing a hook, a route, or the `invite` command
- writing a migration
- a device that reads too little or too much, or pushes and is refused

Not for deployment (`docs/deployment`), and not for the client: the plugin
and the app's sync engine live in the other repositories.

## The collections and their rules

| Collection | Holds | Rules |
| --- | --- | --- |
| `users` | the account: username, password (bcrypt), email optional | view its own; create nobody, since accounts come from the sign-up route; update and delete superusers |
| `profiles` | `name` | `user = @request.auth.id` to list, view, create, update |
| `profile_pins` | `profile`, `pin` | the same |
| `preferences` | `profile`, `name`, `value`; unique `(profile, name)` | the same |
| `connections` | `plugin_id` (`sources/*`, `iptv/*`), `label`, `enabled`, `per_profile`, `fields`, `settings`, `secret_keys`, `secrets` | the same |
| `connection_profile_values` | `connection`, `profile`, `off`, `fields`, `settings`, `secret_keys`, `secrets`; unique `(connection, profile)` | the same |
| `invites` | the code's hash, expiry, who used it | superusers only |

Every data record also has `user` (cascading from `users`), `key` (unique per
user) and `deleted`, and its id is derived by the plugin. Nobody deletes a data
record through the API.

Traps in PocketBase's own field rules:

- **A required bool must be `true`.** `deleted`, `enabled` and `off` are never
  required.
- **A tombstone clears the payload**, so nothing it clears can be required.
  A hook checks live records instead.
- **An update rule sees the stored record.** It must also stop a body that
  names another user, or an update could move a record out of its account.
- **`users` is open by default** — anyone can register, and a user can update
  or delete itself. The first migration closes all three.

## The hooks

- **No guests.** PocketBase takes a missing, expired or invalid token for a
  guest, and a guest's list is empty under the owner rules. Every request on
  account data, and every batch, answers `401` without a valid session.
- **The profile limit.** A new live profile beyond `SC_MAX_PROFILES` is
  refused, `sc_limit`. Deleted profiles do not count.
- **Deleted stays deleted** for profiles and connections: an un-delete is
  refused, `sc_deleted`. PINs, preferences and per-profile values may be
  deleted and set again.
- **Tombstones are cleared**: a write with `deleted: true` keeps `user`, `key`
  and the parents, and empties the rest, secrets included.
- **No hard deletes** of account data, from anyone — the dashboard included.
  Deleting a user cascades.
- **Kept secrets**: a name in `secret_keys` that a write gives no value for
  keeps its stored value; a name dropped from the list drops its value.
- **Every write is judged** as `isAccountRecord` judges a record — a batch's
  writes as sent, and every write as it is about to be stored — by
  `records.Validate`. A refusal is `sc_invalid`.
- **A password change ends every session.** PocketBase refreshes the user's
  token key itself when the password changes; the Go tests prove it. Never add
  a hook that saves a user without letting that happen.

They hold for superusers too: the dashboard goes through the same API.

## The two routes

- **`GET /api/sc/info`** — `{ serverVersion, maxProfiles, signUp }`, with no
  session.
- **`POST /api/sc/sign-up`** — `{ username, password, invite?, firstProfile }`.
  The invite is checked first when `SC_SIGNUP=invite`. One transaction makes
  the user and, with `firstProfile`, a profile named after it — under the id
  the plugin would derive for its key — and spends the invite. It answers
  PocketBase's own sign-in response.

## Migrations

- **Numbered, and never edited once shipped.** A server that ran one never
  runs it again: fix forward with a new one.
- **Automigrate is off.** The collections are written in Go, never made in the
  dashboard.
- **A new field is optional.** An older app never sends it, and upserts update
  only the fields they carry, so a field an older app does not know survives
  its writes.
- **The batch settings hold the largest push**: a whole local account uploaded
  at sign-up. PocketBase's defaults (off, 50 requests, 3 seconds) do not. A
  batch over the limit fails without naming a write, and the client cannot
  act on that.

## What must stay true for the client's reconciliation

The client pushes, reads everything, and reconciles: a pending change is
skipped, a deleted profile or connection is deleted, otherwise the server's
version replaces its own — and a row it holds that the server lacks is taken
for lost and uploaded again. That last rule is why most of this list exists.

1. **Every user sees only their own records, and all of them.** A record
   missing from a read is uploaded again, over whatever newer edit it had. A
   record from another user is someone else's household.
2. **Deletes are soft.** A removed record looks lost; a tombstone looks
   deleted. Nothing but deleting a user removes a row — which is also what
   keeps paged reads from skipping one.
3. **A batch is all or nothing** — PocketBase's own transaction — and a
   refusal names its write: `sc_limit`, `sc_deleted`, or anything else for
   `invalid`. Never replace it with requests one by one: a failure half-way
   would leave the client unable to say what was stored.
4. **The server never resolves conflicts.** It stores what the rules allow and
   returns it. No merge, no winner by `updated`, no refusing a write because
   it looks older.
5. **`info` answers without a session.** The app reads the limit and the
   sign-up mode before anyone signs in.
6. **A session that ended is a `401`.** The plugin signs in once on it, and
   takes anything else at its word.
7. **No per-account lockout.** Throttle by address, as PocketBase's limiter
   does, in memory.

## The tests to run

```bash
go test ./...
go vet ./... && gofmt -l .
(cd harness && npm install && npm test)   # from the plugin's move to records
```

Run both after any change to a collection, rule, hook, route or migration. A
change to the record contract starts in the plugins repository —
`api/src/account.ts` and `api/fixtures/account-records.json` — and runs that
repository's `npm test` too.

## Current state

Phase 6 — the server runs, on PocketBase v0.40.4: the collections and rules,
the hooks, the routes, the invite command, and `go test ./...` over all of
them and the shared fixtures. No device speaks to it until the
`sync/custom-server` plugin moves to records, the next step; the harness
comes with that move.
