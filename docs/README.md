# Documentation — Streaming Center sync server

Your own server: the account a household runs itself, on PocketBase.

These pages describe the server this repository holds. The app's plugin
speaks to it once the account moves to records — Phase 6's next step.

| Folder | What is there |
| --- | --- |
| `getting-started/` | Run it, make the superuser and an invite, sign up from the app |
| `protocol/` | The account protocol the app speaks, and what the server must keep true for it |
| `api/` | The routes the app calls, the collections and their rules, the hooks, errors |
| `deployment/` | Running it for real: the binary or Docker, `.env`, TLS, backups, the dashboard, updating |
| `development/` | Go and PocketBase, migrations, the Go tests, the harness, the shared fixtures |

## Decisions

Re-decided in Phase 5, when the server became PocketBase; each is recorded
with why. Phase 4's own server — its log, derived keys and sealed passwords —
is retired, and its decisions are in git.

| Topic | Decision | Why |
| --- | --- | --- |
| Runtime and storage | PocketBase, used as a Go framework: one binary around one SQLite database in `pb_data`. Pinned to v0.40.x. | It already is most of the server: users, password sign-in and sessions, rules per user, batch writes in one transaction, a dashboard, backups, rate limits. The Go code is what is left — migrations, a few hooks, two routes, a command. Pinned because it is pre-1.0, and minor versions break. |
| The contract | `api` states it, and Go cannot import it. The shared JSON fixtures and a Node harness, test-only, keep the two in step. | The real plugin meets the real binary before a device does. |
| Sync | One collection per kind of record. A device pushes one batch, then reads the whole account. | An account is small — ten profiles, their PINs and preferences, a few connections — so reading it all is cheap, and there is nothing to keep straight: the server's tables are the truth. |
| Auth and sessions | PocketBase's own: a username and a password, bcrypt on the server. Sessions of 30 days, refreshed on every sync; a password change ends them all. | Nothing to invent. The device keeps the password in its keychain to sign in again, once, when a session ends; cutting off a lost device is changing the password. |
| Credentials | Plain text, for now: source and IPTV passwords in `secrets`, readable to the server. PINs readable. | The server is the household's own. Keeping Phase 4's promise that it never learns a password meant bending PocketBase until little of it was used, and a review of that design found seven ways to lose or split data. Sealing end to end stays possible later. |
| Deletes | Soft; final for profiles and connections; never hard, but when an account is deleted. | Every device learns of a delete by reading, and a server that lost a record can be told apart from one that deleted it. |
| Invites | One-time codes from the `invite` command: seven days by default, typed any way, kept as a hash, spent in the same transaction that makes the account. `SC_SIGNUP` can open or close sign-up instead. Public registration is off. | PocketBase's `users` lets anyone register by default. Whoever runs the server hands out access without choosing anyone's password. |
| Tenancy | Several accounts per server, each seeing only its own records. | Families or friends can share one instance. |
| The profile limit | `SC_MAX_PROFILES`, default 10, counting live profiles. A hook enforces it; the app reads it from `info`. | The same ten a local account has. The server is where two devices adding profiles at once meet. |
| Throttling | PocketBase's rate limiter on sign-in and sign-up: per address, in memory. | Never an account-wide lock: that would hand anyone who knows a username a way to keep its owner out. |
| Backups | PocketBase's: a ZIP of `pb_data`, on demand or on a schedule, locally or to S3. | Consistent while it runs, and a restore needs nothing more: devices put back what the backup lacks. |
| Deployment | One binary, or Docker and compose. TLS from a reverse proxy, or from PocketBase's own certificates (`serve <domain>`). | Self-hosters mostly run a proxy already; for those who do not, PocketBase can do it itself. |
