/**
 * The schema, one step per version. Steps are committed and never edited: a
 * server that has run one keeps its data through every later one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    kdf TEXT NOT NULL,
    verifier BLOB NOT NULL,
    vault TEXT NOT NULL,
    epoch TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    installation TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE (account_id, installation)
  ) STRICT;

  CREATE INDEX devices_by_account ON devices(account_id);

  CREATE TABLE invites (
    code_hash BLOB PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  ) STRICT;

  CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL,
    body TEXT NOT NULL,
    stored_at INTEGER NOT NULL,
    UNIQUE (account_id, change_id)
  ) STRICT;

  CREATE INDEX changes_by_account ON changes(account_id, seq);
  `,
];
