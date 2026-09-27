# Deployment

Running the server for real: where it keeps its data, how it is reached, and
how it is backed up. `getting-started` has the quick version.

## With Docker

The image is built from this repository with `@sc/api` from the plugins
repository, which must sit beside it — `docker-compose.yml` passes it as a
second build context.

```bash
cp .env.example .env            # optional
docker compose up -d
docker compose exec sync sc-sync invite
```

- The data lives in the `sync-data` volume, mounted at `/data`.
- The container runs as `node`, listens on 8730, and reports its health from
  `/v1/health`.
- `sc-sync` is on the container's `PATH`: `docker compose exec sync sc-sync
  accounts`, `devices`, `revoke`, `backup`.

Without compose:

```bash
docker build --build-context api=../streaming_center_plugins/api -t streaming-center-sync .
docker run -d --name sync -p 8730:8730 -v sync-data:/data streaming-center-sync
```

## Without Docker

Node 24.7 or later:

```bash
cd ../streaming_center_plugins && npm install
cd ../streaming_center_sync && npm install
npm run build
npm start                      # reads .env if there is one
```

`dist/main.mjs` and `dist/cli.mjs` are one file each, with everything inside:
copying `dist/` is copying the server. Run it under whatever keeps your
services up — systemd, launchd — and stop it with `SIGTERM`, which lets a push
in flight finish.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `SC_SYNC_PORT` | `8730` | Where it listens. In the container it stays 8730: publish another port with `SC_SYNC_PUBLISH`. |
| `SC_SYNC_HOST` | `0.0.0.0` | `127.0.0.1` to take requests only from this machine — a reverse proxy on it. |
| `SC_SYNC_DATA` | `./data` (`/data` in the image) | The database and its lock file. |
| `SC_SYNC_TRUST_PROXY` | off | `1` behind a reverse proxy. Throttling counts by the caller's address, which is then the hop the proxy appended to `X-Forwarded-For`. Never set it without a proxy: anyone could claim any address. |
| `SC_SYNC_PUBLISH` | `8730` | compose only: the host port, or `127.0.0.1:8730` behind a proxy on the same machine. |

## Storage

One SQLite file, `sync.db`, in the data directory, with its write-ahead log
beside it while the server runs.

- **Keep it on a local disk.** SQLite's locking is not safe over NFS or SMB,
  and a Docker volume on one is no better.
- The server takes `server.lock` in the data directory while it runs, and
  removes it when it stops.

## TLS

The server speaks plain HTTP; TLS comes from a reverse proxy in front of it.

**Use TLS anywhere but a home network you trust.** The token a device holds
reads the whole household's log — profiles, PINs, connections. And a device
signing in sends a proof derived from the password, and receives the wrapped
vault key: both are material for guessing the password offline, and with it
every sealed password. On plain HTTP, anyone on the network can take them.

A Caddy example, with the server on the same machine:

```
sync.example.com {
	reverse_proxy 127.0.0.1:8730
}
```

and `SC_SYNC_HOST=127.0.0.1` (or `SC_SYNC_PUBLISH=127.0.0.1:8730` with
compose) and `SC_SYNC_TRUST_PROXY=1`. A base path works too — the app keeps
one typed into the address: `handle_path /sync/* { reverse_proxy 127.0.0.1:8730 }`,
and the app uses `https://example.com/sync`.

The app runs on the web from a secure page, so a browser can only reach an
`https` server — or `http://localhost`.

## Backups

```bash
sc-sync backup /data/backup-$(date +%F).db     # while the server runs
```

A consistent copy, taken through SQLite while the server keeps serving. Keep a
few, somewhere else.

**Restore only with `sc-sync restore`**, with the server stopped:

```bash
docker compose stop sync
docker compose run --rm sync sc-sync restore /data/backup-2026-09-01.db
docker compose start sync
```

It writes the copy through SQLite — a file copied back beside a stale
write-ahead log would replay old pages over it — and gives every account a new
epoch. Every device then hears `reset` and joins again with what it holds, so
whatever changed after the backup comes back from the devices themselves.

It refuses while a server holds the data. A lock from another container
cannot be asked whether its server lives: if that server crashed rather than
stopped, remove `server.lock` from the data directory yourself.

## Updating

**Update the server before the apps.** The server checks every push with the
same rules as the app it was built with; a newer app's change it does not know
yet ends that device's accepted prefix, and the device waits until the server
knows it.

## Accounts and devices

- `sc-sync accounts`, `sc-sync devices <username>` — who is there.
- `sc-sync revoke <device-id>` — a lost phone. The device stops syncing and
  asks for the password again; it never signs itself back in.
- `sc-sync delete-account <username> --yes` — for good, with its devices and
  its log.

A forgotten account password cannot be recovered: nothing can open the vault
key without it. The devices keep everything they hold. Delete the account,
make a new one with a new invite, and sign the devices in to it: they bring
what they hold, and each asks once for its connections' passwords.
