# Sync protocol

The protocol as the client speaks it. The app reaches an account through a
sync plugin's `ConnectedUserStateSyncProvider` (`@sc/api`, in
`streaming_center_plugins/api/src/sync.ts`); this server is the other end of
the `custom-server` plugin, and `test/plugin.test.ts` drives that plugin
against it. The development-only `mock` plugin implements the same contract
in memory, and the app's tests run two devices against a fake account on
every pair of database engines to hold the client to it.

Everything below is what the client relies on. How each call reaches this
server is at the end; `docs/api` has every route.

## One log

An account is one log: an ordered list of changes. Every device appends to it
(`push`) and reads it (`pull`).

- **The log's order is the truth.** There are no clocks. A change carries
  `changedAt`, the time on the device that made it, for display only; nothing
  is ordered by it.
- **The server stores and returns.** It never merges two changes, never picks
  a winner, never rewrites or reorders a change, and never drops one silently.
  Conflicts are the client's, and the client resolves them by the log's order.
- **Several devices push at once.** The server serializes them: each change it
  accepts takes the next place in the log.

## A change

```ts
{ id, changedAt, entity, operation: 'upsert', data }
{ id, changedAt, entity, operation: 'delete', target }
```

| Entity | Upsert data | Delete target | Key |
| --- | --- | --- | --- |
| `profile` | `userId`, `name` | `userId` | `profile/{userId}` |
| `pin` | `userId`, `pin` — four digits, or `null` | never deleted: `pin: null` removes it | `pin/{userId}` |
| `preferences` | `userId`, `key`, `value` (any JSON) | `userId`, `key` | `preferences/{userId}/{key}` |
| `connection` | `connectionId`, `pluginId`, `label`, `media`, `perProfile`, `fields`, `settings`, `secretKeys`, `sealed?` | `connectionId` | `connection/{connectionId}` |
| `profileValues` | `connectionId`, `userId`, `off`, `fields`, `settings`, `secretKeys`, `sealed?` | `connectionId`, `userId` | `profileValues/{connectionId}/{userId}` |

- **`id`** is unique for ever, and the same every time the change is sent
  again: one random id per change the device made. At most 128 characters, and
  never a `/`, since ids join into keys.
- **The key** (`syncKey`) is what a change is about. The client's rules work
  per key; the server has no reason to read one.
- **`isSyncChange`** checks every shape, the PIN's four digits included. The
  client checks every pulled change with it and skips, with a log line, any it
  refuses — that is how an older client passes over an entity it does not
  know yet. The server should check every pushed change with it too.

**What never travels:** session tokens, credential refs, a connection's sync
role (each device chooses its own account), the account's own connection,
device settings such as the default profile or which plugins are installed —
and passwords, except sealed by the app (below). `secretKeys` lists the
*names* of a connection's saved passwords, so a device without them asks for
them instead of signing in with nothing.

**The PIN travels readable.** It keeps a child out of a parent's profile; it is
not an account secret (spec §17). The server stores it like any other value.

## `push`

```ts
push(changes) → { accepted: string[] }
```

- **Idempotent by id.** A change whose id the account has already stored is
  accepted again and stored once. The server remembers every id it has stored
  for as long as the account exists — compaction may drop a change's data,
  never the memory of its id. A resend can come much later: a device whose
  answer was lost may be offline for a week before it tries again. Stored
  twice, the copy would land after newer changes from other devices and
  quietly undo them.
- **`accepted` is a prefix of the ids sent**, in order, and each accepted
  change was durably stored before the answer left. The client moves its place
  in its own journal across that prefix only and sends everything after it
  again, verbatim, on its next run:

  ```
  client sends   [c1 c2 c3 c4 c5]
  server stores  [c1 c2 c3], then fails on c4
  server answers accepted: [c1 c2 c3]
  client sends   [c4 c5] next time
  ```

  Answering for a change that was not stored loses it for good: the client
  will never send it again.
- **A change the server refuses ends the prefix**, like one it failed to
  store. The client builds only changes `isSyncChange` accepts, so a refusal
  means a broken client, and ending the prefix makes it stall rather than lose
  anything.
- **A lost answer is survivable.** The change is in the log; the client did not
  hear so, sends it again (deduplicated), and meanwhile recognises its own id
  when the change comes back through `pull`.

## `pull`

```ts
pull(cursor?) →
  | { kind: 'changes', changes, cursor, more }
  | { kind: 'reset' }
  | { kind: 'expired' }
```

- **The whole log in order**, from after the cursor, or from the start without
  one. Page size is the server's choice; `more` says whether to ask again.
- **The caller's own changes are included.** The client relies on seeing each
  change it pushed come back: until it does, that change protects its key from
  older changes still arriving, and it is how every device ends up applying the
  same log. A server that leaves out a device's own changes leaves that device
  waiting for them for ever.
- **The cursor is opaque** to the client, kept per account, and must stay valid
  across server restarts and deploys: it lives on devices the server does not
  control. Do not assume the cursor received is recent.
- **`reset`** — the account lost data (restored from a backup, wiped), or the
  cursor points into a log that is no longer the one it was issued for. The
  client joins again: it reads the whole log, settles it against what it holds
  (its own rows win where both have something), and announces its rows, so the
  account gets back what it lost.
- **`expired`** — the cursor was compacted away, but nothing was lost. The
  client reads the log from the start and applies it under the usual rules,
  sending nothing extra: re-uploading would overwrite newer edits from other
  devices. This server compacts nothing yet, so it never answers `expired`.

The two are not interchangeable. `reset` for a mere expiry makes every device
upload everything again, overwriting newer edits; `expired` after a data loss
leaves the account without what it lost.

## How the client decides

The server does none of this; it is here so nothing on the server gets in its
way. A device applies pulled changes in log order, with four rules:

1. A change this device has not had back from the account — still to be sent,
   or accepted and not yet returned — protects its key. A pulled change to that
   key is skipped: this device's is later in the log, and wins.
2. A remote delete of a profile or a connection always applies.
3. A device's own changes come back and are applied like any other, which is
   what makes every device converge.
4. A pulled change carrying the id of a change the device still means to send
   is that change's lost acknowledgement.

A page is applied together with its new cursor in one transaction, and only
while the cursor it was pulled from is still the stored one — two tabs of the
same browser never apply the same page twice.

Two narrow exceptions to rule 1, both about passwords:

- A connection whose address or plugin a pulled change moves takes the
  passwords off every profile whose sign-in moved with it — even a profile
  this device changed. They were saved for where it signed in before.
- A password a device's row lists but its store lacks is filled in from a seal
  made for that row's own sign-in, even from a change the device skips. Its own
  change still wins everything else.

## Signing in, and the owner

- **`getStatus()` → `{ accountName? }`** reaches the account and signs in. It
  is what "Sign in" tries — once. `accountName` names the new connection on
  the device.
- **`verifyOwner(proof)`** is Forgot PIN, and the check before switching
  accounts or signing out on a device with profiles. `proof` is the fields the
  manifest's `ownerProof` names — the account password, typed again. It
  resolves when the owner is verified, and otherwise throws:
  - `UNAUTHORIZED` — the proof is wrong
  - `UNAUTHORIZED` with `too-many-attempts` — throttled, so nothing was judged
  - `UNAUTHORIZED` with `signed-out` — the account no longer knows this device;
    the device's own check answers instead
  - anything else — it cannot be asked at all
- **`createAccount(fields)`** creates the account with the manifest's `signUp`
  fields — an invite — and signs in; **`signOut()`** lets this device's
  session go. Both are tried once.
- **`vaultKey()`** is the key the app seals passwords with, derived on the
  device. The server never has it.

The account password never reaches the server. The device derives a proof to
sign in with and a key that wraps the vault key; the server keeps a hash of
the proof and the wrapped key, and can open neither.

## Errors

Every call fails only with an `AppError` and a retry hint, and the client
follows the hint:

| Code | Hint | The client |
| --- | --- | --- |
| `OFFLINE`, `TIMEOUT` | `network-change` or `backoff` | waits for another network, or tries again at 30 s, doubling to 15 min |
| `PROVIDER_UNAVAILABLE` | `backoff` | tries again later, doubling |
| `UNAUTHORIZED` | `never` | stops until the user signs in again — never on a timer, a network change or "Sync now" |
| `UNAUTHORIZED`, `signed-out` | `never` | the same: the server let this device go, and the plugin never signs itself back in |
| `PROVIDER_UNAVAILABLE`, `too-many-attempts` | `backoff` | a throttled sign-in: nothing judged the password, so it may be tried later |

A refused sign-in is never retried by itself: servers lock accounts after a
few failures.

## Sealed passwords

On an account that declares `sealedPasswords`, `connection` and
`profileValues` carry their passwords in `sealed`, by field:

```ts
sealed: { password: 'v1.{key id}.{base64url(nonce ‖ ciphertext ‖ tag)}' }
```

- **The app seals them** with the account's vault key — AES-256-GCM over the
  password and the sign-in it was saved for, bound to the change's key and its
  field. The server never has the key, and nothing on it can open them.
- **The server stores them verbatim**, like any other value. `isSyncChange`
  holds them to a shape: keys among the change's `secretKeys`; a version
  (`v1`, and later ones pass untouched) and base64url parts; at most 4 KiB
  each, and a whole change at most `MAX_CHANGE_LENGTH` (256 KiB).
- **A password is used only with the sign-in it was saved for.** A change
  that points a connection somewhere else — another address, username or
  plugin — leaves its passwords behind on every device, which then asks. So
  whoever holds the account can rewrite an address, but cannot send a
  password there.

## Over HTTP

How the `custom-server` plugin reaches each call; `docs/api` has the routes
in full.

| Call | Routes |
| --- | --- |
| signing in | `POST /v1/auth/params`, then `POST /v1/auth/login` with the derived proof |
| `getStatus` | a sign-in if there is no session, then `GET /v1/status` |
| `pull` | `GET /v1/sync/pull?cursor=` |
| `push` | `POST /v1/sync/push`, in requests of at most 4 MiB and 1,000 changes; the accepted prefix runs across them |
| `verifyOwner` | `POST /v1/auth/verify` with a proof derived from the password typed again |
| `vaultKey` | the session, kept from signing in: the login's answer carries the wrapped key |
| `createAccount` | `POST /v1/accounts` with the invite |
| `signOut` | `POST /v1/auth/logout` |

A `401` on any call with a token means the server let the device go —
`sc-sync revoke`, or the account deleted. The plugin never signs itself back
in with the saved password: that would undo a revoke.
