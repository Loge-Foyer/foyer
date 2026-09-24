---
name: sc-sync-protocol
description: Implement the Streaming Center sync protocol correctly on the server — idempotent push, accepted-prefix confirmation, resumable cursors, and the things the server must never do. Use when building or debugging any endpoint in the sync server.
---

# The sync protocol, server side

Read `../.claude/streaming-center-architecture.md` sections 8 and 9 first. The
server is the other end of `ConnectedUserStateSyncProvider`.

## Three properties that are load-bearing

### 1. `push` must be idempotent

A client may resend the same change after a crash, a timeout, or a rejected
batch. Accepting it twice must not duplicate state.

Key on the change ID the client sends, not on arrival order.

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

### 3. `pull` must be resumable

Return an opaque cursor. The client stores it per connection and hands it back.
It must stay valid across server restarts and deploys — it is persisted on a
device you do not control.

Do not encode anything the client could misuse, and do not assume the cursor you
receive is recent.

## What the server must never do

**Resolve conflicts.** The client owns that, and its rules are entity-specific.
Watch progress resolves by furthest position, never by timestamp — a device that
stops playback and reports position 0 a second later would otherwise erase real
progress. A server that helpfully picks a winner silently corrupts exactly that.

Store and return. Do not decide.

**Store media.** This carries normalized user state. Never video, never
thumbnails, never a stream.

**Hold provider credentials.** It carries what the user watched, not their
Jellyfin password.

**Assume one device.** Several devices sync against the same account
concurrently, and their pushes interleave.

## Shared wire types

Depend on `@sc/api` from the plugins repository for the change and cursor types,
so client and server cannot drift apart on what a change looks like. Never
depend on the app.

## Current state

**Nothing is implemented.** No runtime chosen, no manifest, no build. The
runtime, authentication model and storage are deliberately open until the client
side of the protocol is real.

Record the decision and its reasoning in `docs/` when it is made. One
consideration: TypeScript would let the server consume `@sc/api` directly,
making it structurally impossible for client and server to disagree about the
wire format.
