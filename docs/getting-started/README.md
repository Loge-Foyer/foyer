# Getting started

The sync server is the account a household runs itself: the app's profiles,
their PINs, preferences and connections — the connections' passwords sealed
on the devices, so the server cannot read them — kept in step between its
devices.

## Run it

```bash
cd ../streaming_center_plugins && npm install
cd ../streaming_center_sync && npm install
npm run build && npm start
```

It listens on port 8730 and keeps its data in `./data`. With Docker, the
plugins repository beside this one:

```bash
docker compose up -d
```

and `docker compose exec sync sc-sync …` wherever `npm run sc-sync -- …`
appears below. `docs/deployment` has the settings, TLS and backups.

## Make an account

Accounts are created from the app, with an invite:

```bash
npm run sc-sync -- invite
```

prints a one-time code, valid for seven days. In the app: **Sign in → Your own
server → Create an account**, with the server's address, the code, a username
and a password. Every other device signs in with the same username and
password.

Choose the password with care: it protects everything the server holds, the
sealed passwords included, and nothing can recover it. Whoever runs the server
never sees it.

## Addresses

- The web app on `localhost` reaches `http://localhost:8730`.
- The Android emulator reaches the computer at `http://10.0.2.2:8730`; the iOS
  simulator at `http://localhost:8730`.
- A phone on the same network uses the computer's address,
  `http://192.168.x.x:8730`.
- Anywhere beyond a trusted home network, put it behind TLS.
