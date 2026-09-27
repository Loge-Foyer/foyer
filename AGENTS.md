# AGENTS.md — streaming_center_sync

The self-hosted sync server. Read the workspace root `AGENTS.md` and
`../.claude/streaming-center-architecture.md` first.

**Nothing is implemented. This repository is documentation only** — but the
protocol it will serve is real: `docs/protocol` is what the client speaks.

---

## What this is

A small server someone can run themselves as their **account** — the one sync
connection a device can have — so their profiles, preferences and state follow
them between devices without going through Apple or Google.

It is the counterpart to the `custom-server` sync plugin in
`streaming_center_plugins`. The plugin is the client; this is the server it
talks to.

## What this is not

- **Not a media server.** It never stores or streams video. It carries the app's
  own normalized user state and nothing else.
- **Not required.** A device has at most one account, and none at all is fine:
  state then stays on the device. iCloud and Google are the other accounts.
  This exists for people who want neither.
- **Not where Jellyfin's watch status goes.** A media server masters its own
  watch status; the app caches it and writes it back through that plugin's
  media role (`streaming_center_plugins/plugins/jellyfin`). This server carries
  what no media source masters: profiles, preferences, lists, and progress in
  files and web video.

## Boundaries

Depends on `@sc/api` for wire types, so client and server cannot drift
apart on what a change looks like. Depends on nothing else from the project —
**never** on the app.

## The protocol it must implement

Defined by `ConnectedUserStateSyncProvider` in `api`: `pull`, `push`,
`getStatus`, and `verifyOwner` for Forgot PIN. `docs/protocol` has all of it;
these properties are load-bearing and easy to get wrong:

1. **`push` is idempotent by change id, for ever.** A client resends a change
   after a lost answer, possibly days later. Stored twice, the copy lands after
   newer changes from other devices and undoes them. Remember every id stored,
   even after compacting the data.

2. **`accepted` is a prefix of the ids sent, each durably stored.** The client
   advances its checkpoint only across it and resends the rest verbatim.
   Confirming a change you did not store loses it silently.

3. **`pull` returns the caller's own changes.** The client waits to see each
   change it pushed come back before letting older changes to that entity
   through. Filter them out and that device waits for ever.

4. **`pull` resumes from an opaque cursor** that stays valid across restarts
   and deploys.

5. **`reset` and `expired` mean different things.** `reset`: the account lost
   data, and devices upload what they hold again. `expired`: only the cursor
   is gone, and devices read from the start without uploading. Mixing them up
   either overwrites newer edits or leaves data lost.

6. **Check pushes with `isSyncChange`.** A change it refuses ends the accepted
   prefix, like one that failed to store.

## What it must never do

- **Resolve conflicts.** The client owns that, by the log's order and four
  rules of its own. The server stores and returns, in one order for every
  device; it does not decide which version wins.
- **Hold secrets it does not need.** It carries user state, not provider
  credentials: a connection arrives with the names of its passwords, never the
  values. Phase 4 adds passwords sealed on the device — ciphertext the server
  stores and cannot open.
- **Assume one device or one client.** Several devices sync against the same
  account concurrently.

## Skills

`.agents/skills/` in this repository:

- **`sc-sync-protocol`** — implementing the protocol correctly: idempotent push
  by change id, accepted-prefix confirmation, a device's own changes returned,
  resumable cursors, `reset` versus `expired`, and what the server must never
  do.

---

## Not yet decided

Language and runtime, authentication model, storage, multi-user hosting,
transport. All open. Record the decision and its reasoning in `docs/` when made.

One consideration worth weighing: implementing it in TypeScript would let it
share `@sc/api` directly, which removes any possibility of the client and
server disagreeing about the wire format.

## Current state

`docs/` and these three documents. No code, no dependencies, no build. The
client side is real: the app's sync engine, the `mock` plugin's pretend
account, and two-device tests in the app repository.
