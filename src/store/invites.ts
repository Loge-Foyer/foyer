import type { Database } from './db';

/** Only a hash is kept: a copy of the database cannot be used to create an account. */
export function insertInvite(db: Database, codeHash: Uint8Array, now: number, expiresAt: number): void {
  db.prepare('INSERT INTO invites (code_hash, created_at, expires_at) VALUES (?, ?, ?)').run(codeHash, now, expiresAt);
}

/** Spends an invite that exists, is unused and has not expired. `false` for any other. */
export function spendInvite(db: Database, codeHash: Uint8Array, now: number): boolean {
  const result = db.prepare('UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, codeHash, now);
  return Number(result.changes) === 1;
}
