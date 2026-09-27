# CLAUDE.md — streaming_center_sync

The self-hosted sync server: TypeScript on Node 24, Hono, one SQLite file.

## Reading protocol — before you plan, edit or run anything

1. `../.claude/streaming-center-architecture.md`, especially section 8 (sync
   plugins) and section 9 (local-first writes and syncing with the account).
   The server is the other end of that contract.
2. `../CLAUDE.md` — how the three repositories relate.
3. `AGENTS.md` here — imported below.
4. `docs/protocol/` — the protocol as the client speaks it.

@AGENTS.md

## Why this exists

Someone running Jellyfin at home may not want their profiles and history stored
with Apple or with Google. This is the other account a device can have: a small
server they run themselves that does one job — carry app state between their
own devices. Jellyfin keeps its own watch status, through its media role; that
is not this server's job.

## Decided

`docs/README.md` records each decision and why: the runtime (TypeScript, so
`@sc/api` is the wire format), storage, keys, tokens, throttling, backups.
Change one there first.

**The server never has a key.** The device derives a sign-in proof and a
wrapping key from the account password; the server stores SHA-256 of the proof
and a vault key wrapped on the device. Connection passwords reach it sealed
with that vault key. Nothing here may ever ask for the password itself.

## The rule most likely to be broken

**The server does not resolve conflicts.** It stores changes and returns them,
in one order for every device. The client decides, by that order and rules of
its own: a change it has not seen come back protects its entity, and deletes
of profiles and connections always win. Watch progress, when it travels, will
resolve by furthest position — never by timestamp, because a device reporting
position 0 on stop would otherwise erase real progress.

A server that helpfully picks a winner, reorders, or merges two changes will
silently corrupt all of that.

## The second rule

**Only confirm what you durably stored.** The client advances its checkpoint
across the prefix of changes the server accepts and retries the rest. Confirming
a change you then lose means the client will never send it again. And return a
device's own changes to it on `pull`: it waits to see them.

## Current state

The server is built and tested: accounts from invites, devices and their
tokens, one log per account (idempotent pushes, the accepted prefix, cursors
that answer `reset` for another log), throttling, and `sc-sync` for invites,
devices, backups and restores. `npm test` runs the store, auth and HTTP
suites, a crash test against the bundle, and the command line. The
`custom-server` plugin that talks to it, and the Docker image, come next.

## Git

This repository has **no remote and should not get one**. Commit here; never at
the workspace root. Conventional commit style.
