# Getting started

Your own server is the account a household runs itself: the app's profiles,
their PINs and preferences, and the household's sources and IPTV
subscriptions — with their passwords — kept in step between its devices. It is
PocketBase, with the app's collections added.

> **Until Phase 6** none of this exists yet. This repository holds Phase 4's
> server, `npm start` runs it on port 8730, and its instructions are in git:
> `git show f98384f:docs/getting-started/README.md`.

## Run it

With Go 1.26 or later:

```bash
go run . serve --http=0.0.0.0:8090
```

The first build fetches the Go toolchain PocketBase needs. The server listens
on port 8090 and keeps everything in `./pb_data`. Without `--http` it listens
on this computer only: enough for a browser, the iOS simulator and the Android
emulator here, but not for a phone.

With Docker:

```bash
cp .env.example .env
docker compose up -d
```

and `docker compose exec sync streaming-center-sync …` wherever `go run . …`
appears below. `docs/deployment` has the settings, TLS and backups.

## The superuser

The dashboard, at `http://localhost:8090/_/`, needs a superuser: the server's
administrator. Any one of these makes it:

- `SC_ADMIN_EMAIL` and `SC_ADMIN_PASSWORD` in `.env`, before the first start
- `go run . superuser upsert you@example.com 'a long password'`
- the link PocketBase prints when it starts without one

A superuser sees everything the server holds, every source password included.
Keep that login to yourself.

## Make an account

Accounts are created from the app, with an invite:

```bash
go run . invite                  # a one-time code, good for seven days
go run . invite --expires 1d
```

In the app: **Sign in to your server → Create an account** — from Welcome on a
new device, or from Settings → Account on one already in use. Give the
server's address, the code, a username and a password.

- **On a new device**, the account starts with one profile named after it.
- **On a device already in use**, its local account goes up to the server: its
  profiles, their PINs and preferences, and its sources with their passwords —
  if the server's profile limit has room for them.

Every other device signs in with the same username and password, and takes
the account as the server holds it.

Choose the password with care: it opens every source password the account
holds. If it is forgotten, a superuser can set a new one in the dashboard, and
each device then asks for it once.

## Addresses

- A browser on this computer, and the iOS simulator: `http://localhost:8090`.
- The Android emulator: `http://10.0.2.2:8090`.
- A phone on the same network: the computer's address,
  `http://192.168.x.x:8090`, with the server started with
  `--http=0.0.0.0:8090`.
- Anywhere beyond a trusted home network: behind TLS (`docs/deployment`).

The app on the web runs from a secure page, so a browser can reach only an
`https` server, or one on `localhost`.

## Who may sign up

`SC_SIGNUP`, in `.env`:

- `invite` — the default: a code from `invite`, used once
- `open` — anyone who can reach the server; only on a network you trust
- `closed` — nobody; a superuser makes accounts in the dashboard
