# Account protocol

The protocol as the client speaks it. The app reaches your own server through
the `sync/custom-server` plugin's `ConnectedAccount` (`@sc/api`, in
`streaming_center_plugins/api/src/account.ts`); this server is the other end,
and the harness here drives that plugin against the real binary. The
development-only `sync/mock` plugin plays a pretend PocketBase in memory, and
the app's tests run two devices against a fake one on every pair of database
engines to hold the client to it.

Everything below is what the client relies on. How each call reaches the
server is at the end; `docs/api` has the routes, the collections and their
rules.

> The server speaks this protocol. The app's plugin still speaks Phase 4's
> until the account moves to records, Phase 6's next step.

## An account is its records

An account is small: at most `maxProfiles` profiles, their PINs and
preferences, and a few connections. So a device keeps it in step the simplest
way that works: it pushes what changed, then reads all of it.

- **The server's tables are the truth.** One collection per kind of record,
  one PocketBase user per account. There are no cursors, logs or epochs to
  keep straight.
- **The server stores what the rules allow, and returns it.** It never merges
  two writes, never picks a winner, never decides by a clock. Conflicts are the
  client's (below).
- **Several devices push at once.** SQLite takes their batches one at a time,
  and each is whole before the next begins.

## A record

```ts
{ kind, key, deleted: false, data }
{ kind, key, deleted: true }
```

| Kind | Collection | Data | Key |
| --- | --- | --- | --- |
| `profile` | `profiles` | `userId`, `name` | `{userId}` |
| `pin` | `profile_pins` | `userId`, `pin` — four digits, or `null` | `{userId}` |
| `preference` | `preferences` | `userId`, `name`, `value` (any JSON) | `{userId}/{name}` |
| `connection` | `connections` | `connectionId`, `pluginId`, `label`, `enabled`, `perProfile`, `fields`, `settings`, `secretKeys`, `secrets` | `{connectionId}` |
| `profileValues` | `connection_profile_values` | `connectionId`, `userId`, `off`, `fields`, `settings`, `secretKeys`, `secrets` | `{connectionId}/{userId}` |

- **The key** (`recordKey`) is the app's own id, or its natural key. Ids are
  at most 128 characters and never hold a `/`, since they join into keys.
- **`userId` is a profile.** The app calls its profiles users. On the server,
  `users` are accounts, and a record's `user` is the account that owns it; the
  collections call a profile `profile`.
- **`pluginId` is `sources/*` or `iptv/*`**, never a player or a sync plugin:
  only account-wide connections travel.
- **`isAccountRecord`** checks every shape: the four digits, a known
  per-profile mode, field values that are text, a switch or a library
  selection, secrets only for names the record lists, at most
  `MAX_RECORD_LENGTH` of JSON. The app checks every record it reads with it,
  and skips — with a log line, never the payload — any it refuses. That is how
  an older app passes over a kind it does not know yet.
- **The server judges alike.** Its collections and hooks accept and refuse
  what `isAccountRecord` does, and `api/fixtures/account-records.json` holds
  both sides to it.

### On the server

A record is a PocketBase record in its kind's collection:

- `user` — the account; it cascades when the account is deleted
- `key` — the record's key
- `deleted`
- the data, in snake_case: `plugin_id`, `per_profile`, `secret_keys`
- a child's parents, as relations — `profile`, `connection` — so a batch sends
  parents first

**Record ids are derived by the plugin** from the account's id, the kind and
the key: `recordId()` in the api, the first 15 hex digits of SHA-256 over the
three, a line apart. A
resent write lands on the same record, and two accounts on one server never
collide. The server never picks the id of a record a device writes; the first
profile the sign-up route creates gets the id the plugin would derive for it.

### What never travels

- session tokens and credential refs
- `position` and `version`
- device settings: the default profile, players, sync settings
- sync-category connections — this server's own sign-in among them
- connections of plugins the device's build does not register

A connection lists the names of its saved passwords in `secretKeys`, so a
device where one is missing asks for it instead of signing in with nothing.

**The PIN travels readable.** It keeps a child out of a parent's profile; it is
not an account secret (spec §17). The server stores it like any other value.

## Deletes are soft

- **A delete is a write.** The record stays, `deleted: true`, its payload
  cleared — secrets included. It keeps what identifies it: `user`, `key` and
  its parents.
- **Every device learns of a delete by reading.** And a server that lost a
  record can be told apart from one that deleted it: a missing record was
  lost, a tombstone was deleted.
- **Deleted stays deleted for profiles and connections.** Their ids are random
  and never come back, so an update that would un-delete one is refused
  (`deleted`). PINs, preferences and per-profile values have natural keys, and
  can be deleted and set again.
- **Nothing of an account is removed but with the account.** Deleting a user
  takes every record of it; nothing else does. A record removed by hand would
  read as lost, and the devices would upload it again.
- **A soft delete does not cascade.** A deleted profile's PIN and preferences
  stay as they were, and every device skips a record whose parent is gone.

## Secrets

`connections` and `connection_profile_values` carry two fields for passwords:
`secret_keys`, the names of the saved password fields, and `secrets`, their
values, **in plain text**.

- **A name listed without a value keeps the stored one.** A device that lacks
  a password — an Android restore brings the database back without the
  keystore — still writes a connection's other changes, and the password other
  devices saved survives. A name no longer listed drops its value.
- **A delete clears them.**
- **On a device** they go straight to the keychain, under fresh refs. The
  device database never holds one.

## `push`: one batch, all or nothing

```ts
push(records) →
  | { kind: 'stored' }
  | { kind: 'refused', index, reason: 'limit' | 'deleted' | 'invalid' }
```

- **What goes.** The journal after the checkpoint: each journaled entity as an
  upsert of its current row, its passwords read from the keychain, or as a
  soft delete. Parents first: a profile before its PIN and preferences, a
  connection before its profiles' values.
- **One transaction.** Every write in the batch is stored, or none is.
  `stored` means all of it is on disk.
- **A refusal names the write that stopped it**, by its place in the batch:
  - `limit` — a new live profile beyond `SC_MAX_PROFILES`; deleted ones do not
    count
  - `deleted` — a write that would bring back a deleted profile or connection
  - `invalid` — anything else the rules refuse: a malformed record, one naming
    another account, a child whose parent the server lacks
- **The client deals with it.** It splits a refused batch to find the write,
  then:
  - a profile over the limit stays on this device only, and says so
  - a write to a deleted profile or connection gives way to the delete
  - the checkpoint moves past what was stored
- **A resend is safe.** Every write is an upsert by a derived id, so a batch
  whose answer was lost stores the same thing when it is sent again. It can
  overwrite an edit another device made in between: a known limit, and the
  devices still converge.
- **Only a refusal names a write.** A batch that fails without naming one —
  the server busy, its time up — stored nothing and judged nothing; the client
  tries again later.

## `pull`: everything

```ts
pull() → { records }   // every record of the account, deleted ones included
```

- **A handful of list requests**: each collection, paged. The rules return
  the caller's records and nobody else's; the client asks for no filter.
- **Complete, or an error.** A record left out reads as lost, and a device
  would upload its own copy over it. So a session that ended is a `401`, never
  an empty list, and a read that fails half-way is thrown away.
- **Paged by `id`.** A write between two pages can repeat a record, but never
  hide one — which holds because nothing is ever removed.

## How the client decides

The server does none of this; it is here so that nothing on the server gets in
its way.

1. **Plan**, outside any transaction: PINs and passwords go into the keychain
   under fresh refs.
2. **Apply**, in one unjournaled transaction:
   - An entity with a pending local change is skipped: this device's change
     goes next, and wins.
   - A deleted profile or connection is deleted here, always.
   - Otherwise the server's version replaces the local one where they differ.
   - A local row the server does not have, and that is not pending, was lost
     by the server — a restore — so it is announced again, and the next push
     puts it back.
3. **Clean up:** stale refs go through the janitor, and the engine tells its
   listeners.

Conflicts are settled per entity, and never by a clock: a pending change
first, then deletes of profiles and connections, then the last push, whole.
Two devices editing one connection end on whichever pushed last; nothing is
merged field by field. Every device applies the same server state, and so they
converge.

That asks four things of the server:

- every user sees all of their own records, and nobody else's
- deletes are soft, and a deleted profile or connection stays deleted
- a batch is all or nothing
- nothing on it decides between two versions — not `updated`, not a merge

Watch progress, when it travels, will need more than the last push: a device
that stops playback and reports position 0 would erase real progress. It will
get a field-aware rule on the client — completed first, then the furthest
position — never a timestamp on the server.

## Signing in, sessions and the owner

- **`info()`** needs no sign-in: the server's version, its profile limit and
  how it takes sign-ups. The app reads its limit from here, and whether to
  offer "Create an account", with an invite or without.
- **`status()`** signs in, once: PocketBase's password sign-in, with the
  username and the saved password. It is what "Sign in" tries, and it answers
  the account's id and name ("faruk on home.example.com").
- **A session** is PocketBase's token. It lasts 30 days and is refreshed on
  every sync. It lives in the device-bound store; the password lives in the
  keychain, under the connection's credentials ref.
- **When a session ends** — 30 days offline, the password changed, the account
  deleted — the next call answers `401`. The plugin signs in again with the
  saved password: once, shared by every caller. A refusal is latched: parked
  as "needs sign-in", and never tried again by itself — not on a timer, a
  network change or "Sync now". Only the user signs in again.
- **`verifyOwner(proof)`** — the owner check, for Forgot PIN, signing out and
  switching — is the account password typed again, checked with the same
  sign-in. Wrong, it throws `UNAUTHORIZED`; throttled, `UNAUTHORIZED` with
  `too-many-attempts`, which the app words as "too many tries". A server that
  cannot be reached is a failure, never a quiet fallback to the device.
- **`createAccount(fields, { firstProfile })`** calls the sign-up route with
  the invite. It answers like a sign-in, so the device is signed in at once,
  and it is tried once. A new device asks for a first profile named after the
  account; a device with a local account asks for none, and its first push
  uploads everything it holds.
- **`signOut()`** forgets the session. PocketBase keeps no sessions, so there
  is nothing to end on the server.
- **Cutting off a lost device** is changing the account password, in the
  dashboard. PocketBase refreshes the account's token key when its password
  changes, so every session ends; the Go tests prove it. Each device's saved password is refused once,
  and then it asks.

## Errors

Every call fails only with an `AppError` and a retry hint, and the client
follows the hint:

| The server answers | The plugin | The client |
| --- | --- | --- |
| `401` on a call with a session | signs in once with the saved password | carries on, or parks |
| `400` to a sign-in | throws `UNAUTHORIZED`, `never` | parks until the user signs in again |
| `429` | throws `PROVIDER_UNAVAILABLE`, `too-many-attempts`, `backoff`; for the owner check, `UNAUTHORIZED`, `too-many-attempts` | waits: nothing judged the password |
| `5xx`, or no answer in time | throws `PROVIDER_UNAVAILABLE` or `TIMEOUT`, `backoff` | tries again at 30 s, doubling to 15 min |
| no network, or a home server seen from mobile data | throws `OFFLINE`, `network-change` | waits for another network |

A refused sign-in is never retried by itself. PocketBase only slows an address
down and locks no account, but the rule holds for every server the app talks
to — and devices behind one home address share a limiter, so one device
retrying a changed password would throttle the whole household.

## What plain-text credentials mean

- **The account password** reaches the server only to sign in, and PocketBase
  keeps a bcrypt hash of it.
- **Source and IPTV passwords** are in `secrets` as typed, and every read
  carries them. Whoever has `pb_data`, a backup of it, a superuser login, or
  the traffic without TLS can read every one the household saved.
- **PINs** are readable too.

So: TLS anywhere but a trusted home network, the dashboard kept private, and
backups of `pb_data` kept like password files (`docs/deployment`). Sealing the
passwords on the devices so the server cannot read them, as Phase 4's server
did, is a later option; git keeps that code.

## Over HTTP

| Call | Routes |
| --- | --- |
| `info` | `GET /api/sc/info` |
| `status`, and signing in again | `POST /api/collections/users/auth-with-password` |
| each sync, first | `POST /api/collections/users/auth-refresh` |
| `pull` | `GET /api/collections/{collection}/records` for each of the five, paged by `id` |
| `push` | `POST /api/batch`: one upsert per record, `PUT /api/collections/{collection}/records` with its `id` |
| `verifyOwner` | `POST /api/collections/users/auth-with-password`, with the password typed again |
| `createAccount` | `POST /api/sc/sign-up` |
| `signOut` | none: the device forgets its token |
