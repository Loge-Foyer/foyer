# Deployment

Running the server for real: how it runs, where it keeps its data, how it is
reached, how it is backed up, and how accounts are looked after.
`getting-started` has the quick version.

The binary is `foyer`. In the image it is on the `PATH`, the
data is `/pb_data`, and it listens on 8090. The Dockerfile and compose file
are written and not yet built — Docker was not there when they were — so try
them before you rely on them.

## The binary

```bash
CGO_ENABLED=0 go build -o foyer .
./foyer serve --http=0.0.0.0:8090 --dir=/var/lib/foyer
```

One file, with nothing to install beside it. `GOOS` and `GOARCH` build it for
another machine. Run it under whatever keeps your services up — systemd,
launchd — and stop it with `SIGTERM`.

## With Docker

```bash
cp .env.example .env
docker compose up -d
docker compose exec foyer foyer invite
```

- The image is a two-stage Go build of this repository alone.
- The data lives in the `pb_data` volume.
- It listens on 8090, and reports its health from `/api/health`.
- `docker compose exec foyer foyer …` runs any command —
  `invite`, `superuser`, `migrate` — beside the running server.

Without compose:

```bash
docker build -t foyer .
docker run -d --name foyer -p 8090:8090 -v pb_data:/pb_data --env-file .env foyer
```

## Settings

`.env`, which the server reads when it starts; compose passes it to the
container.

| Variable | Default | |
| --- | --- | --- |
| `FOYER_MAX_PROFILES` | `10` | Profiles an account may hold. The app reads it from the server. Lowering it removes nothing: an account over it keeps its profiles, and adds none. |
| `FOYER_SIGNUP` | `invite` | `invite`, `open` or `closed` (`getting-started`). |
| `FOYER_ADMIN_EMAIL`, `FOYER_ADMIN_PASSWORD` | — | The first superuser, made on the first start. Take the password out of `.env` once it exists; `superuser update` changes it later. |
| `FOYER_TRUST_PROXY` | — | Behind a reverse proxy: the header it puts the caller's address in, such as `X-Forwarded-For`. Never without a proxy (below). |

Until 2026.10.1 these were `SC_…`. A server started with an old name refuses
to start and says the new one, rather than quietly running without its limit
or its proxy header.

And PocketBase's own flags, after `serve`:

| Flag | Default | |
| --- | --- | --- |
| `--http` | `127.0.0.1:8090` | Where it listens. `0.0.0.0:8090` takes requests from other machines; the image does. |
| `--dir` | `pb_data`, beside the binary — or in the working directory, when the binary is called by its name | The data. |
| `--origins` | `*` | Which web origins may call it. If you narrow it, keep the web app's. |
| a domain: `serve sync.example.com` | — | TLS of its own (below). |

**The migrations write the rest into PocketBase's own settings** on the first
start: the session length, the batch API and the rate limits. The dashboard
shows them. Leave them as they are: they are set for what the app needs.

- **Sessions** last 30 days, and every sync refreshes them.
- **The batch API** takes up to 1,000 writes, 32 MiB and 30 seconds: room for
  a whole local account uploaded at sign-up.
- **The rate limits**, per address:

  | What | At most |
  | --- | --- |
  | signing in, and the owner check | 5 a minute |
  | signing up | 5 a minute |
  | refreshing a session | 60 a minute |
  | batches | 30 a minute |
  | the writes inside batches | 5,000 a minute |
  | anything else | 300 in 10 seconds |

  A batch's writes each pass the limiter. Without rules of their own they fall
  to the last one, and a large upload would fail half-way.

`FOYER_TRUST_PROXY` is not a setting the migrations write: the server applies it
on every start, so `.env` stays the one place it is set.

## Storage

Everything is in the data directory, `pb_data`: the database, PocketBase's
logs, local backups, and certificates when it makes its own.

- **Keep it on a local disk.** SQLite's locking is not safe over NFS or SMB,
  and a Docker volume on one is no better.
- **One server per data directory.** Commands such as `invite` can run beside
  it; a second `serve` cannot.
- **It is as sensitive as every password the household saved.** Keep it, and
  anything copied from it, where only you can read it.

## TLS

**Use TLS anywhere but a home network you trust.** On plain HTTP, anyone on
the network reads the account password as a device signs in, and the session
tokens that open the account. And because every sync reads the whole account,
every source password crosses the network each time a device syncs.

### Behind a reverse proxy

Self-hosters mostly run one already. With Caddy on the same machine:

```
sync.example.com {
	@dashboard path /_/*
	respond @dashboard 404
	reverse_proxy 127.0.0.1:8090
}
```

- Start the server with `--http=127.0.0.1:8090`, or publish it with compose on
  `127.0.0.1:8090:8090`, so the proxy is the only way in.
- Set `FOYER_TRUST_PROXY=X-Forwarded-For`.
- The dashboard stays off the proxy. Reach it on the machine itself, or
  through a tunnel: `ssh -L 8090:127.0.0.1:8090 you@server`, then
  `http://localhost:8090/_/`.

A base path works for the app too, since it keeps one typed into the address:
`handle_path /sync/* { reverse_proxy 127.0.0.1:8090 }`, and the app uses
`https://example.com/sync`.

### Its own certificates

```bash
./foyer serve sync.example.com
```

PocketBase gets a certificate from Let's Encrypt, keeps it in `pb_data`, and
listens on 80 and 443. The name must point at this machine, both ports must be
open to the internet — Let's Encrypt checks from outside — and the server
needs the right to bind them: root, or `setcap cap_net_bind_service=+ep` on
the binary. With Docker, publish 80 and 443 instead of 8090.

The app runs on the web from a secure page, so a browser can reach only an
`https` server — or one on `localhost`.

## The trusted proxy

The rate limiter counts per address, and the superusers' allowed addresses
(below) go by address too. PocketBase takes the address from the connection,
unless `FOYER_TRUST_PROXY` names a header to take it from.

- **Behind a proxy, set it.** Otherwise every caller has the proxy's address:
  one stranger's tries throttle the whole household, and an address allowed
  for superusers lets anyone in through the proxy.
- **Without a proxy, never.** Anyone could send the header, and claim any
  address.

With `X-Forwarded-For`, PocketBase takes the last address in it: the one your
proxy added.

## Keep the dashboard private

`/_/` and a superuser login read everything: every account, every PIN, and
every source password, in plain text.

- **Keep it off the proxy**, as above.
- **Allow superusers only from your own network:** in the dashboard's
  settings, or with `foyer superuser ips 192.168.1.0/24`. The
  command writes the settings to the database, and a running server keeps its
  own copy: restart it afterwards. Behind a proxy, this works only with
  `FOYER_TRUST_PROXY`.
- **A long superuser password**, and none left in `.env`.
- **Never change the app's collections, rules or settings there.** The
  migrations own them, and a rule loosened by hand opens one household's data
  to another.

## Backups

PocketBase makes them, under Settings → Backups in the dashboard.

- **A backup is a ZIP of `pb_data`**, taken while the server runs, on demand
  or on a schedule that keeps the last few.
- **It goes to `pb_data/backups`, or to S3.** A copy on the same disk does not
  survive the disk: keep one somewhere else. S3's keys sit in PocketBase's
  settings; `--encryptionEnv` keeps those settings encrypted.
- **It holds every password** the households saved, in plain text. Keep it
  like a password file: encrypted, and nowhere shared.
- **Restoring** from the dashboard replaces `pb_data` and restarts the server.
  By hand: stop it, put the backup's contents in place of `pb_data`, start it.

### What a restore means for devices

Nothing tells the devices, and nothing needs to: each finds out on its next
sync.

- **Records made since the backup come back** from the devices that hold
  them. A device takes a record it holds, and the server lacks, for one the
  server lost, and uploads it again.
- **Edits made since the backup are undone.** The server's older version
  replaces them on every device, unless a device still has one waiting to be
  sent.
- **What was deleted since can come back.**
- **Passwords changed since are the old ones again** — the account's, and
  sources' — and the devices ask.
- **An account made since is gone.** Its devices ask to sign in. Signing out
  keeps their copy as a local account, and a new account, with a new invite,
  uploads it.

So restore when the data is lost, not to undo a mistake.

## Updating

**Update the server before the apps.** Its collections and hooks judge records
by the contract they were written against. A newer app can send something an
older server refuses, and that write is refused until the server knows it.
Update the server first, and every app it serves can store what it sends.

**Back up first.** A new release may bring migrations. They run at its first
start, and going back to the old binary does not undo them.

PocketBase is inside the binary, pinned: updating this server is how
PocketBase is updated, never on its own.

## Accounts

The dashboard's `users` collection is every account on the server. The
profiles, PINs, preferences, connections and per-profile values of each are in
their collections, under the account's `user`.

- **A forgotten password.** Open the user, and set a new password. Every
  session ends; each device's saved password is refused once, and then it asks
  — type the new one.
- **A lost device.** Change the password, the same way. The lost device is
  refused once and never tries again; the others ask for the new one.
- **Deleting an account.** Delete the user, and everything of it goes with it.
  Its devices ask to sign in; signing out keeps their copy as a local account.
- **Leave the records alone.** Deleting one is refused: a record removed by
  hand would read as lost, and come back from the devices. An edit is a write
  like any device's: every device takes it on its next sync, unless it has a
  change of its own waiting.
- **Invites** are in `invites`: when each expires, and who used it. Make them
  with `invite`.
- **An account made in the dashboard starts with no profiles.** Signing up
  from the app is the usual way: it brings a first profile, or a whole local
  account.
