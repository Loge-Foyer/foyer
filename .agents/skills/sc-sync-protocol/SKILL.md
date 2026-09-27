---
name: sc-sync-protocol
description: Implement the Streaming Center sync protocol correctly on the server — idempotent push by change id, accepted-prefix confirmation, returning a device's own changes, resumable cursors, reset versus expired, and the things the server must never do. Use when building or debugging any endpoint in the sync server.
---

# The sync protocol, server side

Read `../.claude/streaming-center-architecture.md` sections 8 and 9, then
`docs/protocol/README.md` — the protocol as the client already speaks it. The
server is the other end of `ConnectedUserStateSyncProvider`.

## The properties that are load-bearing

### 1. `push` must be idempotent — for ever

A client resends a change after a crash, a timeout or a lost answer, possibly
days later. Accepting it twice must not store it twice: the copy would land
after newer changes from other devices and quietly undo them.

Key on the change id the client sends, not on arrival order, and remember every
id you stored even after compacting the data behind it.

### 2. Confirm only what you durably stored

The response reports which change IDs were **accepted**. The client advances its
checkpoint across the accepted prefix and retries everything after it.

```
client sends   [c1 c2 c3 c4 c5]
server stores  [c1 c2 c3]  and fails on c4
server returns accepted: [c1 c2 c3]
client resends [c4 c5] next time
```

**Confirming a change you then lose means the client never sends it again.**
That is permanent data loss, caused entirely by the server, and invisible until
someone notices their history is wrong.

Acknowledge after the write is durable, never before.

A change `isSyncChange` refuses ends the prefix too. The client only builds
changes it accepts, so a refusal means a broken client — which then stalls
rather than loses anything.

### 3. `pull` returns the caller's own changes

The whole log, in one order, the caller's own changes included. A device waits
to see each change it pushed come back: until then that change protects its
entity from older ones still arriving. Leave a device's own changes out and it
waits for ever.

### 4. `pull` must be resumable

Return an opaque cursor. The client stores it per connection and hands it back.
It must stay valid across server restarts and deploys — it is persisted on a
device you do not control.

Do not encode anything the client could misuse, and do not assume the cursor you
receive is recent.

### 5. `reset` is not `expired`

- `reset` — the account lost data, or the cursor belongs to a log that is gone.
  Devices join again and upload what they hold.
- `expired` — only the cursor was compacted away. Devices read from the start
  and upload nothing extra.

Answering `reset` for an expiry makes every device overwrite newer edits;
answering `expired` after a loss leaves the account without what it lost.

## What the server must never do

**Resolve conflicts.** The client owns that: the log's order, and four rules
of its own (`docs/protocol`). When watch progress travels it will resolve by
furthest position, never by timestamp — a device that stops playback and
reports position 0 a second later would otherwise erase real progress. A server
that picks a winner, reorders or merges changes silently corrupts all of it.

Store and return. Do not decide.

**Store media.** This carries normalized user state. Never video, never
thumbnails, never a stream.

**Hold provider credentials.** It carries what the user watched, not their
Jellyfin password. A connection arrives with the names of its saved passwords
only. Phase 4 adds passwords sealed on the device, with a key derived from the
account password — ciphertext to store, never to open.

**Assume one device.** Several devices sync against the same account
concurrently, and their pushes interleave.

## Shared wire types

Depend on `@sc/api` from the plugins repository for the change and cursor types,
so client and server cannot drift apart on what a change looks like. Never
depend on the app.

## Current state

**Nothing is implemented.** No runtime chosen, no manifest, no build. The client
side of the protocol is real now — the app's sync engine, the `mock` plugin's
pretend account, and two-device tests in the app — so the runtime,
authentication model and storage can be chosen against it.

Record the decision and its reasoning in `docs/` when it is made. One
consideration: TypeScript would let the server consume `@sc/api` directly,
making it structurally impossible for client and server to disagree about the
wire format.
