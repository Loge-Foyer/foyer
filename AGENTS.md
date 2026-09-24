# AGENTS.md — streaming_center_sync

The self-hosted sync server. Read the workspace root `AGENTS.md` and
`../.claude/streaming-center-architecture.md` first.

**Nothing is implemented. This repository is documentation only.**

---

## What this is

A small server someone can run themselves so their viewing state syncs between
their devices — without routing it through a media server, Apple or Google.

It is the counterpart to the `custom-server` sync plugin in
`streaming_center_plugins`. The plugin is the client; this is the server it
talks to.

## What this is not

- **Not a media server.** It never stores or streams video. It carries the app's
  own normalized user state and nothing else.
- **Not required.** Local-only, iCloud, Google and the Jellyfin state bridge are
  all alternatives. This exists for people who want neither a cloud account nor
  their history living with a media server.
- **Not where the Jellyfin bridge lives.** Pushing state back to Jellyfin is a
  plugin concern: it is the sync role of
  `streaming_center_plugins/plugins/jellyfin`.

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

## Not yet decided

Language and runtime, authentication model, storage, multi-user hosting,
transport. All open. Record the decision and its reasoning in `docs/` when made.

One consideration worth weighing: implementing it in TypeScript would let it
share `@sc/api` directly, which removes any possibility of the client and
server disagreeing about the wire format.

## Current state

`docs/` and these three documents. No code, no dependencies, no build.
