# Development

> **Until Phase 6** this repository holds Phase 4's TypeScript server:
> `npm install`, `npm test` and `npm start` run it, and nothing below exists
> yet. Its instructions are in git:
> `git show f98384f:docs/development/README.md`.

```bash
go run . serve                    # the server, on 127.0.0.1:8090; data in ./pb_data
go run . invite                   # a one-time code for "Create an account"
go run . superuser upsert you@example.com 'a long password'
go test ./...                     # every Go test
go vet ./... && gofmt -l .        # nothing to report
(cd harness && npm install && npm test)   # the real plugin against the real binary
go build -o streaming-center-sync .       # one static binary
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
- **`.env`** is read when the server starts: `SC_MAX_PROFILES`, `SC_SIGNUP`,
  `SC_ADMIN_EMAIL`, `SC_ADMIN_PASSWORD`, `SC_TRUST_PROXY`.

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
- **Sign-up:** each `SC_SIGNUP` mode; an invite used once, and expiring;
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

**The harness**, `harness/`, is Node and vitest, and test-only. It builds the
binary, starts it on a temporary directory, and drives the real
`sync/custom-server` plugin — aliased to its source in
`../streaming_center_plugins`, never installed — over a Node host with an
in-memory keychain:

- sign up, and a second device signs in
- both converge
- the owner check
- the password changed: the other device is refused once, then parked
- signing out

It is the one place TypeScript touches this repository, and its `AGENTS.md`
says so. Nothing the server ships comes from it.

**The shared fixtures** are
`../streaming_center_plugins/api/fixtures/account-records.json`: records every
side must accept, and records every side must refuse, each with its reason.
The api's tests judge them with `isAccountRecord`; the Go tests map each to its
collection, as the plugin does, and expect the same verdict. A change to the
record contract changes that file first, in the plugins repository, then the
collections here, and both suites run.

The app's tests prove the client side of the same protocol, two devices at a
time, against a fake PocketBase on every pair of database engines.
