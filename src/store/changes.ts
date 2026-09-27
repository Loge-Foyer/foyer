import { isSyncChange } from '@sc/api';

import { decodeCursor, encodeCursor } from '../cursor';
import { transaction, type Database } from './db';
import { integer, text } from './rows';

/**
 * Where a push can be made to fail on purpose: the tests' storage errors, and
 * the crash test's exits. Nothing sets them in normal running.
 */
export interface Faults {
  /** Before each insert of a push, with how many it has inserted so far. */
  readonly beforeInsert?: (inserted: number) => void;
  /** After a push commits, before its answer leaves. */
  readonly afterCommit?: () => void;
}

export interface PageLimits {
  readonly count: number;
  readonly bytes: number;
}

export type Pulled =
  | { readonly kind: 'changes'; readonly bodies: readonly string[]; readonly cursor: string; readonly more: boolean }
  | { readonly kind: 'reset' };

/**
 * Stores what it is sent, in order, until a change it refuses: ids already
 * stored are accepted again and stored once. Everything accepted is on disk
 * before this returns — the prefix is the promise. A storage error rolls the
 * whole push back, and nothing is accepted.
 */
export function pushChanges(db: Database, accountId: number, changes: readonly unknown[], now: number, faults: Faults = {}): readonly string[] {
  const accepted: string[] = [];
  const stored = db.prepare('SELECT 1 FROM changes WHERE account_id = ? AND change_id = ?');
  const insert = db.prepare('INSERT INTO changes (account_id, change_id, body, stored_at) VALUES (?, ?, ?, ?)');
  transaction(db, () => {
    let inserted = 0;
    for (const change of changes) {
      // The size limit is part of the check: both sides refuse the same changes.
      if (!isSyncChange(change)) break;
      if (!stored.get(accountId, change.id)) {
        faults.beforeInsert?.(inserted);
        // Verbatim: a field this server does not know still reaches the devices that do.
        insert.run(accountId, change.id, JSON.stringify(change), now);
        inserted += 1;
      }
      accepted.push(change.id);
    }
  });
  faults.afterCommit?.();
  return accepted;
}

/**
 * The log after a cursor, in the order it was stored — the caller's own
 * changes included. A cursor from another log answers `reset`.
 */
export function pullChanges(
  db: Database,
  account: { readonly id: number; readonly epoch: string },
  cursorText: string | undefined,
  limits: PageLimits,
): Pulled {
  let position: { readonly seq: number; readonly changeId?: string } = { seq: 0 };
  if (cursorText !== undefined) {
    const cursor = decodeCursor(cursorText);
    if (!cursor || cursor.epoch !== account.epoch) return { kind: 'reset' };
    if (cursor.seq > 0) {
      const at = db.prepare('SELECT change_id FROM changes WHERE account_id = ? AND seq = ?').get(account.id, cursor.seq);
      // Gone, or another change in its place: a log restored from an older copy.
      if (!at || text(at, 'change_id') !== cursor.changeId) return { kind: 'reset' };
    }
    position = cursor;
  }

  const rows = db
    .prepare('SELECT seq, change_id, body FROM changes WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(account.id, position.seq, limits.count + 1);
  const bodies: string[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limits.count)) {
    const body = text(row, 'body');
    // Always at least one, so a page is never empty while the log has more.
    if (bodies.length > 0 && bytes + body.length > limits.bytes) break;
    bodies.push(body);
    bytes += body.length;
    position = { seq: integer(row, 'seq'), changeId: text(row, 'change_id') };
  }

  return { kind: 'changes', bodies, cursor: encodeCursor({ epoch: account.epoch, ...position }), more: rows.length > bodies.length };
}
