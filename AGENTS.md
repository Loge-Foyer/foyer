# AGENTS.md — streaming_center_sync

The self-hosted sync server. Read the workspace root `AGENTS.md` and
`../.claude/streaming-center-architecture.md` first.

**Nothing is implemented. This repository is documentation only.**

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
`getStatus`. Three properties are load-bearing and easy to get wrong:

1. **`push` must be idempotent at the server.** A client may resend the same
   change after a crash or a network failure. Accepting it twice must not
   duplicate state.

2. **The response must report the accepted prefix.** The client advances its
   checkpoint only across changes the server confirms, and retries the rest
   verbatim. Confirming changes you did not durably store causes silent data
   loss on the client.

3. **`pull` must be resumable via an opaque cursor.** The client stores it per
   connection. It must remain valid across restarts.

## What it must never do

- **Resolve conflicts.** The client owns that. The server stores and returns;
  it does not decide which version wins.
- **Hold secrets it does not need.** It carries user state, not provider
  credentials.
- **Assume one device or one client.** Several devices sync against the same
  account concurrently.

## Skills

`.agents/skills/` in this repository:

- **`sc-sync-protocol`** — implementing the protocol correctly: idempotent push,
  accepted-prefix confirmation, resumable cursors, and what the server must
  never do.

---

## Not yet decided

Language and runtime, authentication model, storage, multi-user hosting,
transport. All open. Record the decision and its reasoning in `docs/` when made.

One consideration worth weighing: implementing it in TypeScript would let it
share `@sc/api` directly, which removes any possibility of the client and
server disagreeing about the wire format.

## Current state

`docs/` and these three documents. No code, no dependencies, no build.
