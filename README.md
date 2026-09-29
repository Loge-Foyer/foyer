# Streaming Center — your own server

A small server you run yourself, so your household's account — its profiles,
their settings, and your sources with their passwords — follows you between
your own devices.

It is [PocketBase](https://pocketbase.io), with the app's collections added:
one program, one database, and a dashboard to see what it holds.

> Phase 5 has just written this design down. Until Phase 6 builds it, this
> repository still holds the earlier server — see *Current state*.

---

## The problem it solves

You add your Jellyfin server on your phone. You pick up the tablet. It should
already have it — the address, the sign-in, your profile's home screen —
without you typing a password again.

Everything you set up in the app lives in your **account**: your profiles,
their PINs and preferences, and the sources and IPTV subscriptions you added.
A device holds one account, and it lives in one of two places:

- **On the device.** Nothing to run. To move it, export a backup file, or let
  the app keep one in iCloud, Google Drive or OneDrive.
- **On your own server** — this. Every device signed in to it stays in step.

What you watched on a media server is already taken care of: Jellyfin keeps
its own record, and the app reads it from there and writes it back there. That
never goes through this server.

## Why you might want this one

Because a lot of people who run their own media server do not want a cloud
account.

- **It is live.** A backup file moves an account; this keeps several devices
  on one.
- **It is shared.** Everyone in the household signs in to the same account and
  picks their own profile. Friends or family can have accounts of their own on
  the same server.
- **It is yours.** It runs where you run it, and its dashboard shows
  everything it holds.
- **Its password resets a forgotten PIN.**

And it keeps two concerns separate. Your films come from wherever you keep
films. Your account goes wherever you want it. Changing one should not force
the other.

## What it will and will not do

**Will:** keep each account's profiles, PINs, preferences, sources and IPTV
subscriptions, with their passwords; hand them to every device signed in to
it; keep what one device deleted deleted on the others; hold an account to its
profile limit — ten, unless you say otherwise; and let people in only with an
invite you made, unless you open it.

**Will not:** store or stream video; decide which version wins when two
devices edit the same thing — the app does that, and the last change sent
wins; or keep your source passwords from whoever runs it.

That last one deserves plain words. **Your sources' passwords are stored as you
typed them.** Whoever has the server's data folder, a backup of it, or its
dashboard login can read every one. That is the price of keeping the server
simple, for now. So run it yourself, put it behind TLS if it leaves your home
network, keep the dashboard to yourself, and treat its backups like a list of
passwords.

Your account password is different: the server keeps only a hash of it. PINs
are readable too — a PIN is a child lock, not a password.

## Current state

**Phase 5 — the new architecture, written down.** Everything above is the
design this repository is moving to. Until Phase 6 replaces it, this
repository still holds the TypeScript server from Phase 4 — Node 24, Hono, one
SQLite file, one log per account, `sc-sync`, port 8730. `npm start` runs that
one, and today's app speaks its protocol, with connections' passwords sealed
on the devices. The PocketBase server described here does not exist yet.

## Documentation

`docs/` covers getting started, the account protocol, the routes and
collections, deployment and development.

The full architecture is in
[`../.claude/streaming-center-architecture.md`](../.claude/streaming-center-architecture.md).
