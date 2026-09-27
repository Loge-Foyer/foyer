# CLAUDE.md — streaming_center_sync

The self-hosted sync server. **Nothing is implemented yet** — this repository is
documentation only.

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

## Before writing any code here

Two questions are open and should be answered deliberately, in `docs/`, rather
than settled by whatever gets typed first:

**What runtime?** TypeScript would let the server consume `@sc/api`
directly, which makes it structurally impossible for client and server to
disagree about the wire format. That is a real advantage over any other choice,
and worth weighing seriously against familiarity or deployment preference.

**What authentication?** This is a personal server holding a viewing history.
The threat model is not the same as a public service, and over-engineering it
will stop it from ever being finished.

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

`docs/` with five topic folders, and these three documents. No code, no package
manifest, no build. `docs/protocol` is written — the client side is real.

## Git

This repository has **no remote and should not get one**. Commit here; never at
the workspace root. Conventional commit style.
