# Documentation — Streaming Center sync server

The self-hosted sync server: the account a household runs itself.

| Folder | What is there |
| --- | --- |
| `getting-started/` | Run it, make an invite, sign in from the app |
| `protocol/` | The protocol the app speaks, and what the server must answer |
| `api/` | Every HTTP route |
| `deployment/` | Running it for real: storage, TLS, backups |
| `development/` | Setup, tests, the crash test |

## Decisions

These were open until the server was written; each is recorded with why.

| Topic | Decision | Why |
| --- | --- | --- |
| Runtime | TypeScript on Node 24. | It consumes `@sc/api` directly — the wire types and `isSyncChange` are the client's own — so client and server cannot drift. Node 24 has `node:sqlite` and every hash the server needs built in. |
| HTTP | Hono on `@hono/node-server`. | Small and standards-based: its handlers take a `Request` and return a `Response`, so tests call the app in-process with no port, and CORS and body limits are middleware. |
| Storage | One SQLite file (`node:sqlite`): WAL, `synchronous = FULL`, foreign keys on. Numbered migrations, one transaction each; a database from a newer server is refused. | A household's log is small, and one file is easy to back up. `FULL` puts a push on disk before its answer leaves — the accepted prefix promises exactly that. |
| `@sc/api` | Aliased to its source in the plugins repository (tsconfig, esbuild, vitest), never installed. | One copy, nothing to fetch, and a Docker build can copy the source in. `npm` `file:` links are symlinks a Docker build cannot follow. |
| Build | esbuild bundles `src/main.ts` and `src/cli.ts` into `dist/`. | `@sc/api`'s extensionless imports do not run under Node's type stripping; one file each runs with nothing installed. |
| Keys | The device derives everything from the account password: a sign-in proof, and a key that wraps a random vault key. The server stores the key's parameters, SHA-256 of the proof, and the wrapped vault key — never the password, never a key. | The household's connection passwords travel sealed with the vault key. A server that never sees it cannot open them. |
| Verifier | Plain SHA-256 of the proof, compared in constant time. | The proof is a 256-bit key. Guessing the password behind it costs a full PBKDF2 per guess whatever the server does — the wrapped vault key tests a guess just as well, and cannot be peppered. |
| Accounts | Created from the app, with a one-time invite from `sc-sync invite`. | Whoever runs the server never learns the password. |
| Tokens | 32 random bytes per device, stored hashed. One row per installation: signing in again replaces its token. | Revoking a device ends it; a copy of the database signs no one in. |
| Throttling | In memory. Misses at sign-in count per name and address, at verify per device, at invites per address, plus a wider budget per address. Five free, then 30 s, doubling to 15 min; a success clears it. | Never persisted and never an account-wide lock: either would hand anyone who knows a username a way to keep its owner out. |
| Cursors | Opaque: the account's epoch, a position, and the id of the change stored there. | A cursor from another log — another epoch, or a copy restored under it — answers `reset`, and its device joins again. |
| Backups | `sc-sync backup` copies the database while it runs; `sc-sync restore` puts one back with the server stopped, through SQLite's backup API, and renews every account's epoch. | A file copied back beside a stale write-ahead log would replay old pages; and devices must learn the log is not the one they knew. |
| Tenancy | One household per account; several accounts per server. | Families or friends can share one instance. |
| Deployment | Docker and compose, or `npm start`. TLS from the user's reverse proxy. | Self-hosters already run a proxy; the server stays plain HTTP behind it. |
