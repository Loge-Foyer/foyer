# Streaming Center — sync server

A small server you run yourself, so your viewing history follows you between
your own devices.

**No server is built yet.** The protocol it will speak is real: the app speaks
it today, to a pretend account in development builds.

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
is correct when two devices disagree, or hold your media server passwords. Those
all belong elsewhere on purpose.

## Current state

Documentation only. No code.

The client side of the protocol is real now: the app signs in to an account,
sends every change it makes and applies every change the account holds, and its
tests prove several devices end up the same through lost answers, partial
pushes and an account that forgets. `docs/protocol` is that protocol, as the
client speaks it — what this server must answer.

The runtime, the authentication model and the storage layer are still open,
and can now be chosen against a protocol that exists.

## Documentation

`docs/` covers getting started, the sync protocol, the eventual API, deployment
and development. Each folder explains what will go there.

The full architecture is in
[`../.claude/streaming-center-architecture.md`](../.claude/streaming-center-architecture.md).
