# Streaming Center — sync server

A small server you run yourself, so your viewing history follows you between
your own devices.

**Nothing is built yet.** This repository is currently a plan.

---

## The problem it solves

You watch half a film on your phone. You sit down at the TV. It should already
know where you got to.

Making that work means your viewing state has to live somewhere both devices can
reach. There are a few ways to arrange that, and Streaming Center supports all
of them as separate, optional plugins:

- **Nowhere.** State stays on each device. Simple, and genuinely fine if you
  only use one.
- **iCloud or Google.** Convenient if you are already in one of those
  ecosystems, and nothing to run.
- **Back to your media server.** Jellyfin already tracks what you have watched,
  so the app can keep it in step. But it has nowhere to put things like your
  theme preference or home screen layout, so it can only carry part of the
  picture.
- **This.** A small server of your own.

## Why you might want this one

Because the self-hosting audience often does not want a cloud account, and does
not want their viewing history tied to their media server either.

Tying it to the media server has a practical cost too, not just a philosophical
one: a media server can only store the state it has fields for. Your own server
can hold everything the app knows — profiles, preferences, progress, favourites,
lists, home layout.

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

The runtime, the authentication model and the storage layer are all still open
questions — deliberately so, since they are easier to answer well once the
client side of the protocol is real.

## Documentation

`docs/` covers getting started, the sync protocol, the eventual API, deployment
and development. Each folder explains what will go there.

The full architecture is in
[`../.claude/streaming-center-architecture.md`](../.claude/streaming-center-architecture.md).
