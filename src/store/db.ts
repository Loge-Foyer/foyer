import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from './migrations';

export type Database = DatabaseSync;

/**
 * The server's one database. WAL lets readers go on while a push writes, and
 * `synchronous = FULL` puts a commit on disk before the answer that says so
 * leaves — the accepted prefix promises exactly that.
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('SQLite would not switch foreign keys on.');
  migrate(db);
  return db;
}

/** All or nothing. Synchronous, so nothing else runs on the server while it holds the database. */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db: Database): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  // Guessing at a newer schema could lose what it holds.
  if (version > MIGRATIONS.length) {
    throw new Error(`This database was written by a newer server (schema ${version}); this one knows ${MIGRATIONS.length}.`);
  }
  for (let step = version; step < MIGRATIONS.length; step += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[step] ?? '');
      db.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
}
