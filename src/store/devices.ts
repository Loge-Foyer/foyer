import type { Database } from './db';
import { integer, text, type Row } from './rows';

export interface Device {
  readonly id: string;
  readonly accountId: number;
  /** Stable for one install of the app: signing in again from it replaces its token, not its row. */
  readonly installation: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

const SEEN_EVERY_MS = 60_000;

function toDevice(row: Row): Device {
  return {
    id: text(row, 'id'),
    accountId: integer(row, 'account_id'),
    installation: text(row, 'installation'),
    name: text(row, 'name'),
    createdAt: integer(row, 'created_at'),
    lastSeenAt: integer(row, 'last_seen_at'),
  };
}

/** A sign-in: the installation's row, with a new token — or a new row for a new installation. */
export function signInDevice(
  db: Database,
  device: { readonly id: string; readonly accountId: number; readonly installation: string; readonly name: string; readonly tokenHash: Uint8Array; readonly now: number },
): Device {
  db.prepare(
    `INSERT INTO devices (id, account_id, installation, name, token_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, installation) DO UPDATE SET token_hash = excluded.token_hash, name = excluded.name, last_seen_at = excluded.last_seen_at`,
  ).run(device.id, device.accountId, device.installation, device.name, device.tokenHash, device.now, device.now);
  const row = db.prepare('SELECT * FROM devices WHERE account_id = ? AND installation = ?').get(device.accountId, device.installation);
  if (!row) throw new Error('The device was not stored.');
  return toDevice(row);
}

export function deviceByTokenHash(db: Database, tokenHash: Uint8Array): Device | undefined {
  const row = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash);
  return row ? toDevice(row) : undefined;
}

/** When a device was last heard from — written at most once a minute, not on every call. */
export function touchDevice(db: Database, device: Device, now: number): void {
  if (now - device.lastSeenAt < SEEN_EVERY_MS) return;
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
}

export function devicesOf(db: Database, accountId: number): readonly Device[] {
  return db.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id').all(accountId).map(toDevice);
}

export function deleteDevice(db: Database, id: string, accountId?: number): boolean {
  const result =
    accountId === undefined
      ? db.prepare('DELETE FROM devices WHERE id = ?').run(id)
      : db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ?').run(id, accountId);
  return Number(result.changes) > 0;
}
