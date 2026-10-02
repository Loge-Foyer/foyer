# Development

```bash
go run . serve                    # the server, on 127.0.0.1:8090; data in ./pb_data
go run . invite                   # a one-time code for "Create an account"
go run . superuser upsert you@example.com 'a long password'
go test ./...                     # every Go test
go vet ./... && gofmt -l .        # nothing to report
(cd harness && npm install && npm test)   # the real plugin against the real binary
go build -o foyer .       # one static binary
```

## Go and PocketBase

- **PocketBase is pinned** in `go.mod`, to v0.40.x. It is pre-1.0, and its
  minor versions break its Go API: update deliberately, one version at a time,
  reading its release notes, and let the Go tests find what moved.
- **v0.40 needs Go 1.27.** A Go 1.26 install is enough to start: with
  `GOTOOLCHAIN=auto`, the default, the go command fetches the toolchain
  `go.mod` asks for on the first build. `go env GOTOOLCHAIN` says which; some
  distributions set `local`, and then it is Go 1.27 or nothing.
- **No cgo.** PocketBase's SQLite is pure Go, so `CGO_ENABLED=0` builds a
  static binary.
- **`go run . serve`** keeps its data in `./pb_data`, in the working directory;
  a built binary keeps it beside itself, and `--dir` puts it anywhere. Delete
  `pb_data` to start again from nothing.
- **`.env`** is read when the server starts: `FOYER_MAX_PROFILES`, `FOYER_SIGNUP`,
  `FOYER_ADMIN_EMAIL`, `FOYER_ADMIN_PASSWORD`, `FOYER_TRUST_PROXY`.
- **Dev mode is off unless asked for** (`--dev`). PocketBase turns it on by
  itself under `go run`, and it prints every SQL statement to stdout — which
  buried the code `invite` prints, the one line a script reads. `main.go`
  keeps it off by default; `go run . serve --dev` still shows the statements.

## The version

`internal/version/version.go` is Foyer's version, and it is always Loge's:
`YEAR.MONTH.BUILD`, where `BUILD` counts every release of the pair and never
starts again. The app's `npm run release` moves both, and refuses when they
disagree; the harness fails when the server answers another version than the
app's `package.json`. `info` answers it, and `foyer --version` prints it.
`../loge/docs/development` has the whole scheme.

## Migrations

`migrations/` holds the schema, as Go, in numbered files. PocketBase applies
the ones a server has not run at every start, and remembers them.

- **Never edit one that has shipped.** A server that ran it never runs it
  again: fix forward with a new one.
- **Automigrate is off**, and the collections are never changed in the
  dashboard: what is made there exists on one machine only.
- **A new field is optional.** Older apps never send it.

## Tests

**The Go tests** use PocketBase's `tests` package. Each runs on a temporary
data directory, with the migrations applied:

- **Rules:** two users never see each other's records; a write naming another
  user is refused; a guest gets `401`, never an empty list.
- **Sign-up:** each `FOYER_SIGNUP` mode; an invite used once, and expiring;
  `firstProfile` makes a profile named after the account; a public create of a
  user is refused.
- **The hooks:** the limit counts only live profiles; an un-delete of a
  profile or connection is refused; a PIN or preference can be deleted and set
  again; a tombstone is cleared; a hard delete is refused, while deleting a
  user cascades; a listed secret a write lacks keeps its value.
- **Batch:** stored all or nothing, naming the write refused; a resent batch
  changes nothing; the largest push fits.
- **Sessions:** 30 days; a password change ends every one.
- **Records:** the shared fixtures, accepted and refused as in TypeScript.

**The harness** (`harness/`) is Node and vitest, and test-only. It builds the
binary once, starts it for each test on a temporary directory and a free
port — with the rate limits on, as in production — and drives the real
`sync/custom-server` plugin, aliased to its source in
`../loge/adapters` and never installed, over a Node host: `fetch`,
node:crypto, and a session store that outlives a provider. It counts the
sign-ins each device makes:

- sign up with an invite, a second device signs in, and each reads what the
  other wrote, record for record, passwords included
- the server's rules through the plugin: the limit, deleted stays deleted, a
  password a write leaves out kept, all or nothing, an invalid write named
- a resent batch changes nothing; a whole account fits one batch
- the owner check takes the password typed again, and an empty one never
  reaches the server
- the password changed elsewhere: the other device is refused once, then
  parked — across a relaunch — until it signs in with the new one
- a session that ended: one more sign-in, with the saved password
- signing out forgets the session; a first profile at sign-up; an invite spent
  once, and a closed or open server
- throttled sign-ins wait (`backoff`, `too-many-attempts`), and latch nothing

It is the one place TypeScript touches this repository, and its `AGENTS.md`
says so. Nothing the server ships comes from it.

**The shared fixtures** are
`../loge/adapters/api/fixtures/account-records.json`: records every
side must accept, and records every side must refuse, each with its reason.
The api's tests judge them with `isAccountRecord`; the Go tests map each to its
collection, as the plugin does, and expect the same verdict. A change to the
record contract changes that file first, in the app's `adapters/api`, then the
collections here, and both suites run.

The app's tests prove the client side of the same protocol, two devices at a
time, against a fake PocketBase on every pair of database engines.
