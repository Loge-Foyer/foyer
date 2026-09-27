# Streaming Center — sync server

A small server you run yourself, so your viewing history follows you between
your own devices.

It is built: `docker compose up -d`, or `npm install && npm run build && npm
start`, then an invite from `sc-sync invite`. `docs/getting-started` has the
rest.

---

## The problem it solves

You watch half a film on your phone. You sit down at the TV. It should already
know where you got to.

Making that work means your state has to live somewhere both devices can
reach. For films on a media server that part is already solved: Jellyfin keeps
its own record of what you watched, and the app reads it from there and writes
it back there.

Everything else — your profiles, their preferences and home screens, progress
in files and web video that no server tracks — lives with your **account**. A
device has at most one, and there are three ways to have it:

- **None.** State stays on each device. Simple, and genuinely fine if you only
  use one.
- **iCloud or Google.** Convenient if you are already in one of those
  ecosystems, and nothing to run.
- **This.** A small server of your own.

## Why you might want this one

Because the self-hosting audience often does not want a cloud account.

Your own server can hold everything the account carries — profiles,
preferences, favourites, lists, home layout, progress in files and web video.
Its password is also what resets a profile's forgotten PIN.

And it keeps the two concerns genuinely separate. Your films come from wherever
you keep films. Your viewing state goes wherever you want it. Changing one
should not force the other.

## What it will and will not do

**Will:** accept changes from your devices, hand them back to your other
devices, and survive a client crashing partway through without losing or
duplicating anything.

**Will not:** store or stream video, decide which version of your watch progress
is correct when two devices disagree, or read your media server passwords — it
carries them sealed on your devices, and cannot open them. Those all belong
elsewhere on purpose.

## Current state

The server runs. It keeps one log per account in a single SQLite file, stores
every change once however often a device sends it, answers only for what is on
disk, and survives being killed half-way through a push without losing or
duplicating anything — its tests kill it there to make sure.

Accounts are created from the app with a one-time invite, so whoever runs the
server never learns the password. The server never sees the key your
connections' passwords are sealed with, either: it stores what it cannot open.

The plugin that talks to it — "Your own server" in the app — is built and
tested against it; creating an account from the app's screens comes next.
Docker and compose files are written; `docs/deployment` has running it for
real.

## Documentation

`docs/` covers getting started, the sync protocol, every route, deployment
and development.

The full architecture is in
[`../.claude/streaming-center-architecture.md`](../.claude/streaming-center-architecture.md).
