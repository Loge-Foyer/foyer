# API reference

The routes the `sync/custom-server` plugin calls, the collections behind them,
and how they fail. Most are PocketBase's own, used as they are; two are this
server's. `protocol/` says what the calls mean.

- Bodies are JSON.
- The session token goes in `Authorization`; PocketBase takes it with or
  without `Bearer `.
- Errors are PocketBase's: `{ "status", "message", "data" }`, where `data`
  holds field errors, each `{ "code", "message" }`.

## This server's routes

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/sc/info` | — | `{ serverVersion, maxProfiles, signUp }`, without a session |
| `POST /api/sc/sign-up` | `{ username, password, invite?, firstProfile }` | PocketBase's sign-in answer, `{ token, record }`; `403` when sign-up is closed or the invite will not do; `400` with field errors |

- **`signUp`** is `invite`, `open` or `closed`, from `SC_SIGNUP`.
  **`maxProfiles`** is `SC_MAX_PROFILES`.
- **`invite`** is needed when `signUp` is `invite`: a code from the `invite`
  command, typed any way — case, dashes and spaces do not matter, and `O`, `I`
  and `L` read as `0`, `1` and `1`. It is checked before anything else, so
  without one nobody learns which usernames exist.
- **`firstProfile: true`** also creates a profile named after the account,
  under a fresh key and the id the plugin would derive for it. A device
  uploading a local account sends `false`.
- **One transaction** creates the user and the first profile, and spends the
  invite: an invite is never spent on an account that was not made.
- `400` field errors: `username`, taken or not a username; `password`, too
  short.
- Rate-limited per address, like signing in.

## PocketBase's routes

| Call | Route | Answer |
| --- | --- | --- |
| sign in, and the owner check | `POST /api/collections/users/auth-with-password`, `{ identity, password }` with the username as `identity` | `{ token, record }`; `400` for a wrong name or password alike |
| keep the session | `POST /api/collections/users/auth-refresh` | `{ token, record }`, good for another 30 days; `401` when the session ended |
| read | `GET /api/collections/{collection}/records?page=&perPage=&sort=id&skipTotal=1` | `{ page, perPage, items, … }`, up to 1,000 a page |
| write | `POST /api/batch`, `{ requests }` | one answer per request; or `400`, naming the request that stopped it |
| health | `GET /api/health` | `200` while it serves |

- **Reading.** The rules make every list the caller's own; no filter is
  needed. Sorting by `id` keeps the pages stable: a write between two pages can
  repeat a record, never hide one.
- **Writing.** Each request of a batch is an upsert:
  `{ "method": "PUT", "url": "/api/collections/{collection}/records", "body": { "id": … } }`.
  PocketBase updates the record when its id exists, and creates it when not.
  A soft delete is an upsert too; a batch never holds a `DELETE`.
- **The batch is one transaction.** At the first request that fails it stops
  and stores nothing: the answer is `400`, and `data.requests.{index}` holds
  that request's own error in `response`.
- **The batch API is on**, set by the migrations with room and time for a
  whole account: the largest push is a local account uploaded at sign-up.
  PocketBase's defaults — off, 50 requests, 3 seconds — would not do.
- **Signing out** has no route. PocketBase keeps no sessions; the device
  forgets its token.

## The collections

Every data collection has these, besides its own fields:

| Field | |
| --- | --- |
| `id` | `recordId()` in the api: the first 15 hex digits of SHA-256 over the account's id, the kind and `key`, a line apart. A write under any other id is refused |
| `user` | relation to `users`, required; cascades when the user is deleted |
| `key` | the record's key, `recordKey()` in `api`; unique per `(user, key)` |
| `deleted` | the soft delete |

| Collection | Kind | Its own fields |
| --- | --- | --- |
| `profiles` | `profile` | `name` |
| `profile_pins` | `pin` | `profile`, `pin` — four digits, or empty |
| `preferences` | `preference` | `profile`, `name`, `value` (JSON) |
| `connections` | `connection` | `plugin_id`, `label`, `enabled`, `per_profile`, `fields`, `settings`, `secret_keys`, `secrets` |
| `connection_profile_values` | `profileValues` | `connection`, `profile`, `off`, `fields`, `settings`, `secret_keys`, `secrets` |

- **`plugin_id`** is `sources/<name>` or `iptv/<name>`, the name kebab-case.
  Players and sync plugins stay on each device.
- **`per_profile`** is `none`, `credentials` or `all`.
- **`profile` and `connection`** are relations to the parent record, so a
  child cannot exist without it; that is why a batch sends parents first. A
  child names its parents by their derived ids, from its own key.
- **`(user, key)` is unique** in every collection. A preference's key holds
  its profile and its name, and a profile's values' key its connection and
  its profile, so that is one of each per profile too.
- **JSON fields** hold the api's limits: a record at most `MAX_RECORD_LENGTH`
  of JSON, a secret at most 4 KiB.
- **`secrets`** is plain text: the source and IPTV passwords, as typed.

The other two:

- **`users`** — the account: PocketBase's own auth collection. A `username`,
  unique and compared without regard to case, and a password, kept as a
  bcrypt hash; `email` optional. Password sign-in only: OAuth2, OTP and MFA
  are off. Sessions last 30 days.
- **`invites`** — the code's hash, when it expires, and who used it, when.

### Rules

| Collection | List, view | Create | Update | Delete |
| --- | --- | --- | --- | --- |
| the five data collections | `user = @request.auth.id` | `user = @request.auth.id` | `user = @request.auth.id`, and never to another user | nobody: superusers only, and the hooks refuse those too |
| `users` | its own record | nobody: accounts come from the sign-up route | superusers | superusers; the cascade takes the account's records |
| `invites` | superusers | superusers | superusers | superusers |

PocketBase's defaults for `users` let anyone register; the first migration
closes that.

### The hooks

- **No guests on account data.** PocketBase treats a missing, expired or
  invalid token as a guest, and under these rules a guest's list comes back
  empty — which a device would take for a server that lost everything. So
  every request on the data collections, and every batch, answers `401`
  without a valid session.
- **The profile limit.** A new live profile beyond `SC_MAX_PROFILES` is
  refused, `sc_limit`. Deleted profiles do not count.
- **Deleted stays deleted.** An update that un-deletes a profile or a
  connection is refused, `sc_deleted`.
- **A tombstone is cleared.** A write with `deleted: true` keeps `user`, `key`
  and the parents, and empties the rest, secrets included, whatever the body
  says.
- **No hard deletes.** A delete of account data is refused — from a device, a
  batch or the dashboard. Deleting a user still cascades.
- **Kept secrets.** On an update, a name in `secret_keys` without a value in
  `secrets` keeps its stored value; a name dropped from `secret_keys` drops
  its value.
- **Every write is judged** the way `isAccountRecord` judges a record: the
  key's shape, the derived id, the parents the key names, and the data. A
  batch's writes are judged as sent, before PocketBase casts anything — a
  `"no"` sent for a boolean is refused, where PocketBase would read `false` —
  and every write again as it is about to be stored, however it came.
- **A password change ends every session.** PocketBase itself refreshes the
  user's token key when the password changes, so every token issued before
  stops working; the Go tests prove it.

The hooks hold for superusers too: the dashboard goes through the same API.

## Errors

| Status | When |
| --- | --- |
| `400` | a refused sign-in; a record the rules or hooks refuse; a batch, naming the request that stopped it |
| `401` | no valid session: it expired, the password changed, or the account was deleted |
| `403` | sign-up closed, or an invite that will not do; the batch API off; a superuser from an address not allowed |
| `404` | a record that is not the caller's |
| `429` | throttled |

**Inside a failed batch**, `data.requests.{index}.response` is the refused
request's own error. The hooks name their reason as a field error's `code`:

- `sc_limit` — the profile limit, on `user`
- `sc_deleted` — a deleted profile or connection, on `deleted`
- `sc_invalid` — a record the api would refuse, on the field at fault

```json
{ "status": 400, "message": "Batch transaction failed.", "data": { "requests": { "3": {
  "code": "batch_request_failed", "message": "Batch request failed.",
  "response": { "status": 400, "message": "…", "data": { "user": { "code": "sc_limit", "message": "…" } } }
} } } }
```

Anything but `sc_limit` and `sc_deleted` is `invalid` to the plugin. A batch
that fails without naming a request — its time up, too many requests, the
batch API off — stored nothing and judged nothing, and the plugin reads it as
`backoff`.

## Rate limits

PocketBase's rate limiter, switched on by the migrations, guards sign-in and
sign-up; `docs/deployment` lists its rules. It counts per address, in memory, and never per account, so nobody
who knows a username can keep its owner out. Behind a proxy it needs
`SC_TRUST_PROXY` (`docs/deployment`).
