import type { Database } from './db';
import { blob, integer, text, type Row } from './rows';

/** A key's parameters as stored and sent: the salt as base64url. */
export interface StoredKdf {
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly salt: string;
}

export interface Account {
  readonly id: number;
  readonly username: string;
  readonly kdf: StoredKdf;
  /** SHA-256 of the sign-in proof. */
  readonly verifier: Uint8Array;
  /** The vault key, sealed on the device with a key only the password gives. Opaque here. */
  readonly vault: string;
  /** Renewed whenever the account's log is not the one its devices knew: every cursor from before answers `reset`. */
  readonly epoch: string;
  readonly createdAt: number;
}

function toAccount(row: Row): Account {
  return {
    id: integer(row, 'id'),
    username: text(row, 'username'),
    kdf: JSON.parse(text(row, 'kdf')) as StoredKdf,
    verifier: blob(row, 'verifier'),
    vault: text(row, 'vault'),
    epoch: text(row, 'epoch'),
    createdAt: integer(row, 'created_at'),
  };
}

export function accountByName(db: Database, username: string): Account | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
  return row ? toAccount(row) : undefined;
}

export function accountById(db: Database, id: number): Account | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return row ? toAccount(row) : undefined;
}

export function insertAccount(db: Database, account: Omit<Account, 'id'>): Account {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO accounts (username, kdf, verifier, vault, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(account.username, JSON.stringify(account.kdf), account.verifier, account.vault, account.epoch, account.createdAt);
  return { ...account, id: Number(lastInsertRowid) };
}

/** Goes with its devices and its log. */
export function deleteAccount(db: Database, username: string): boolean {
  return Number(db.prepare('DELETE FROM accounts WHERE username = ?').run(username).changes) > 0;
}

export interface AccountSummary {
  readonly username: string;
  readonly createdAt: number;
  readonly devices: number;
  readonly changes: number;
}

export function listAccounts(db: Database): readonly AccountSummary[] {
  return db
    .prepare(
      `SELECT username, created_at,
              (SELECT COUNT(*) FROM devices WHERE account_id = accounts.id) AS devices,
              (SELECT COUNT(*) FROM changes WHERE account_id = accounts.id) AS changes
       FROM accounts ORDER BY username`,
    )
    .all()
    .map((row) => ({ username: text(row, 'username'), createdAt: integer(row, 'created_at'), devices: integer(row, 'devices'), changes: integer(row, 'changes') }));
}

/** A new epoch for every account — after a restore, when no log is the one its devices knew. */
export function renewEpochs(db: Database, epoch: () => string): number {
  const ids = db.prepare('SELECT id FROM accounts').all().map((row) => integer(row, 'id'));
  const update = db.prepare('UPDATE accounts SET epoch = ? WHERE id = ?');
  for (const id of ids) update.run(epoch(), id);
  return ids.length;
}
