# CLAUDE.md — streaming_center_sync

Your own server: PocketBase, used as a Go framework — collections per user,
invites, the profile limit.

## Reading protocol — before you plan, edit or run anything

1. `../.claude/streaming-center-architecture.md`, especially §7 (the account
   role), §9 (syncing with your own server), §10 (conflicts) and §17 (your own
   server). The server is the other end of that contract.
2. `../CLAUDE.md` — how the three repositories relate.
3. `AGENTS.md` here — imported below.
4. `docs/protocol/` — the protocol as the client speaks it — and `docs/api/`.

@AGENTS.md

## Why this exists

Someone running Jellyfin at home may not want their household's profiles and
sources stored with Apple or with Google. This is the account they run
themselves: a small server that does one job — keep the account in step
between their own devices. Jellyfin keeps its own watch status, through its
media role; that is not this server's job.

It is PocketBase because PocketBase already is most of it: users, password
sign-in and sessions, rules per user, batch writes in one transaction, a
dashboard, backups and rate limits. The Go code here is the rest — migrations,
a few hooks, two routes and a command — and should stay that small.

## Decided

`docs/README.md` records each decision and why: PocketBase and Go, its own
sign-in and sessions, plain-text credentials for now, invites, tenancy, the
profile limit, backups, deployment. Change one there first.

**Credentials are plain text on this server, for now.** Source and IPTV
passwords sit in `secrets` as typed; the account password is PocketBase's
bcrypt hash. So `pb_data`, its backups and a superuser login are as sensitive
as every password the household uses. Say so wherever it matters, and never
quietly weaken TLS, the dashboard's privacy or how backups are kept.

## The rule most likely to be broken

**The server does not resolve conflicts.** It stores what the rules allow and
returns it. The client decides: a pending change protects its entity, deletes
of profiles and connections always win, and otherwise the last push wins,
whole. Watch progress, when it travels, will resolve on the client by the
furthest position — never by timestamp, because a device reporting position 0
on stop would otherwise erase real progress.

A server that helpfully picks a winner by `updated`, merges two writes field by
field, or refuses a write because it looks older will silently break all of
that, and the devices stop converging.

## The second rule

**What a device reads must be the whole account, and only its own.** The
client takes a record it holds and the server lacks for one the server lost,
and uploads it again. So a list must never come back short: not for a guest —
a session that ended answers `401` — not because something was removed by
hand, and not because a rule filtered it by mistake. And never another user's
record: several households share a server.

## Current state

**Phase 6 — the server runs.** PocketBase v0.40.4, used as a Go framework:
the account's collections and their rules, the hooks, `info` and `sign-up`,
and the `invite` command. `go test ./...` proves it — the rules, sign-up and
invites, the hooks, batches, sessions and the shared fixtures. The app's
`sync/custom-server` plugin still speaks the retired Phase 4 protocol until it
moves to records, the next step, so no device syncs with this server yet; the
harness that drives the real plugin against it comes with that move. The
Dockerfile and compose file are written, and not yet built: Docker was not
there. The Phase 4 TypeScript server is gone; git keeps it.

## Git

This repository has **no remote and should not get one**. Commit here; never at
the workspace root. Conventional commit style.
