# API reference

Every route, as the `custom-server` plugin calls it. Bodies are JSON; bytes are
base64url without padding. `protocol/` says what the calls mean.

Errors are `{ "error": "<code>" }` with a status. Routes marked **bearer** need
`Authorization: Bearer <token>` and answer `401 unauthorized` without a valid
one — which, for a device that had one, means it was revoked, or its account
deleted.

## Accounts and sign-in

| Route | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | — | `{ ok, version }` |
| `POST /v1/auth/params` | `{ username }` | `{ kdf: { algorithm, iterations, salt } }` — the same shape for a name no account has |
| `POST /v1/accounts` | `{ invite, username, kdf, proof, vault, installation, deviceName }` | as a sign-in; `403 invite` (used, expired or unknown — checked first), `409 taken`, `400 invalid` |
| `POST /v1/auth/login` | `{ username, proof, installation, deviceName }` | `{ token, device: { id }, account: { name }, vault }`; `401 unauthorized` |
| `POST /v1/auth/verify` **bearer** | `{ proof }` | `204`; `403 wrong-proof` |
| `POST /v1/auth/logout` **bearer** | — | `204`: this device is let go |
| `GET /v1/status` **bearer** | — | `{ account: { name }, device: { id, name } }` |
| `GET /v1/devices` **bearer** | — | `{ devices: [{ id, name, createdAt, lastSeenAt, current }] }` |
| `DELETE /v1/devices/:id` **bearer** | — | `204`; `404 not-found` for a device of another account |

- **`username`** is compared as NFC in lower case: `[a-z0-9._-]{1,64}`.
- **`kdf`** is `{ algorithm: 'pbkdf2-sha256', iterations, salt }`, held to
  `isKdfParams`'s limits — 600k to 2M iterations, a 16–64-byte salt — on both
  sides.
- **`proof`** is 32 bytes; **`vault`** is opaque, at most 1 KiB.
- **`installation`** names one install of the app: a sign-in from it replaces
  its token instead of adding a device.
- **`invite`** is a code from `sc-sync invite`, typed any way: case, dashes and
  spaces do not matter.

## The log

| Route | Body | Answer |
| --- | --- | --- |
| `POST /v1/sync/push` **bearer** | `{ changes }` (at most 1,000) | `{ accepted }`, a prefix of the ids sent; `503 storage` when nothing could be stored |
| `GET /v1/sync/pull?cursor=&limit=` **bearer** | — | `{ kind: 'changes', changes, cursor, more }` or `{ kind: 'reset' }` |

- A page holds up to `limit` changes (200 by default, 500 at most) or about
  2 MiB, and always at least one while the log has more.
- `expired` is never answered yet: nothing is compacted.

## Throttling

`429 too-many-attempts`, with `Retry-After` in seconds, when a bucket is
waiting: sign-in per name and address, verify per device, invites per address,
and a wider budget per address. The plugin reports a throttled sign-in as
something to retry later, and a throttled verify as too many tries.

## Limits

A request body of at most 8 MiB (`413 too-large`). A change of at most
`MAX_CHANGE_LENGTH` characters of JSON, and sealed values of at most 4 KiB
each — `isSyncChange`'s limits, which the app holds itself to as well.
