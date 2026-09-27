import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import type { SyncChange } from '@sc/api';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeCursor } from '../src/cursor';
import { insertAccount, renewEpochs, type Account } from '../src/store/accounts';
import { pullChanges, pushChanges, type Faults, type Pulled } from '../src/store/changes';
import { openDatabase, type Database } from '../src/store/db';
import { profile } from './support/server';

const PAGE = { count: 50, bytes: 1024 * 1024 };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-sync-store-'));
  dirs.push(dir);
  const path = join(dir, 'sync.db');
  return { dir, path, db: openDatabase(path) };
}

function newAccount(db: Database, username = 'family', epoch = 'epoch-1'): Account {
  return insertAccount(db, {
    username,
    kdf: { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: 'c2FsdHNhbHRzYWx0c2FsdA' },
    verifier: new Uint8Array(32),
    vault: 'dmF1bHQ',
    epoch,
    createdAt: 1,
  });
}

function changes(pulled: Pulled): readonly SyncChange[] {
  if (pulled.kind !== 'changes') throw new Error(`pulled ${pulled.kind}`);
  return pulled.bodies.map((body) => JSON.parse(body) as SyncChange);
}

const ids = (pulled: Pulled) => changes(pulled).map((change) => change.id);

describe('the database', () => {
  it('is created at the current schema, and a reopen changes nothing', () => {
    const { db, path } = fresh();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    newAccount(db);
    db.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.n).toBe(1);
    reopened.close();
  });

  it('refuses a database a newer server wrote, rather than guess at it', () => {
    const { db, path } = fresh();
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer server/);
  });

  it('takes an account’s devices and log with it', () => {
    const { db } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('c1', 'Alex')], 1);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()?.n).toBe(0);
  });
});

describe('pushing', () => {
  it('stores a change once however often it is sent, and accepts it every time', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const batch = [profile('c1', 'Alex'), profile('c2', 'Sam')];
    expect(pushChanges(db, account.id, batch, 1)).toEqual(['c1', 'c2']);
    expect(pushChanges(db, account.id, batch, 2)).toEqual(['c1', 'c2']);
    expect(ids(pullChanges(db, account, undefined, PAGE))).toEqual(['c1', 'c2']);
  });

  it('ends the accepted prefix at the first change it refuses', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const refused = { ...profile('c2', 'Sam'), entity: 'watchProgress' };
    expect(pushChanges(db, account.id, [profile('c1', 'Alex'), refused, profile('c3', 'Robin')], 1)).toEqual(['c1']);
    expect(ids(pullChanges(db, account, undefined, PAGE))).toEqual(['c1']);
  });

  it('refuses a change heavier than both sides allow, as the device would', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const heavy: SyncChange = { id: 'h', changedAt: 1, entity: 'preferences', operation: 'upsert', data: { userId: 'u' as never, key: 'homeLayout', value: 'x'.repeat(300_000) } };
    expect(pushChanges(db, account.id, [profile('c1', 'Alex'), heavy], 1)).toEqual(['c1']);
  });

  it('accepts nothing when storing fails half-way, and stores the resend once', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const batch = [profile('c1', 'Alex'), profile('c2', 'Sam'), profile('c3', 'Robin')];
    const failing: Faults = {
      beforeInsert: (inserted) => {
        if (inserted === 2) throw new Error('disk full');
      },
    };
    expect(() => pushChanges(db, account.id, batch, 1, failing)).toThrow('disk full');
    expect(ids(pullChanges(db, account, undefined, PAGE))).toEqual([]);
    expect(pushChanges(db, account.id, batch, 2)).toEqual(['c1', 'c2', 'c3']);
    expect(ids(pullChanges(db, account, undefined, PAGE))).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps a field it does not know', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const newer = { ...profile('c1', 'Alex'), arrivesLater: { kind: 'unknown here' } };
    pushChanges(db, account.id, [newer], 1);
    expect(changes(pullChanges(db, account, undefined, PAGE))).toEqual([newer]);
  });

  it('keeps accounts apart', () => {
    const { db } = fresh();
    const one = newAccount(db, 'one');
    const two = newAccount(db, 'two');
    pushChanges(db, one.id, [profile('c1', 'Alex')], 1);
    pushChanges(db, two.id, [profile('c1', 'Sam')], 1);
    expect(changes(pullChanges(db, one, undefined, PAGE)).map((change) => change.operation === 'upsert' && 'name' in change.data && change.data.name)).toEqual(['Alex']);
    expect(changes(pullChanges(db, two, undefined, PAGE)).map((change) => change.operation === 'upsert' && 'name' in change.data && change.data.name)).toEqual(['Sam']);
  });
});

describe('pulling', () => {
  it('pages the log in the order it was stored, and says when there is more', () => {
    const { db } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, Array.from({ length: 120 }, (_, index) => profile(`c${index}`, `P${index}`)), 1);
    const sizes: number[] = [];
    let cursor: string | undefined;
    const seen: string[] = [];
    for (;;) {
      const page = pullChanges(db, account, cursor, PAGE);
      if (page.kind !== 'changes') throw new Error(page.kind);
      sizes.push(page.bodies.length);
      seen.push(...ids(page));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, index) => `c${index}`));
  });

  it('keeps a page under its byte limit, but never empty', () => {
    const { db } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('c1', 'Alex'), profile('c2', 'Sam'), profile('c3', 'Robin')], 1);
    const page = pullChanges(db, account, undefined, { count: 50, bytes: 1 });
    expect(ids(page)).toEqual(['c1']);
    expect(page.kind === 'changes' && page.more).toBe(true);
  });

  it('returns each device’s own changes, interleaved in one order for every device', () => {
    const { db } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('a1', 'Alex')], 1);
    pushChanges(db, account.id, [profile('b1', 'Sam')], 2);
    pushChanges(db, account.id, [profile('a2', 'Robin'), profile('b1', 'Sam')], 3);
    pushChanges(db, account.id, [profile('b2', 'Kim')], 4);
    expect(ids(pullChanges(db, account, undefined, PAGE))).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('resumes from a cursor after the server restarts', () => {
    const { db, path } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('c1', 'Alex')], 1);
    const first = pullChanges(db, account, undefined, PAGE);
    if (first.kind !== 'changes') throw new Error(first.kind);
    pushChanges(db, account.id, [profile('c2', 'Sam')], 2);
    db.close();
    const reopened = openDatabase(path);
    expect(ids(pullChanges(reopened, account, first.cursor, PAGE))).toEqual(['c2']);
    reopened.close();
  });

  it('gives an empty log a cursor that works once it has changes', () => {
    const { db } = fresh();
    const account = newAccount(db);
    const empty = pullChanges(db, account, undefined, PAGE);
    if (empty.kind !== 'changes') throw new Error(empty.kind);
    expect(empty.bodies).toEqual([]);
    expect(decodeCursor(empty.cursor)).toEqual({ epoch: 'epoch-1', seq: 0 });
    pushChanges(db, account.id, [profile('c1', 'Alex')], 1);
    expect(ids(pullChanges(db, account, empty.cursor, PAGE))).toEqual(['c1']);
  });

  it('answers reset for a cursor from another epoch, past the end, or not this server’s', () => {
    const { db } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('c1', 'Alex')], 1);
    const page = pullChanges(db, account, undefined, PAGE);
    if (page.kind !== 'changes') throw new Error(page.kind);
    expect(pullChanges(db, { ...account, epoch: 'epoch-2' }, page.cursor, PAGE)).toEqual({ kind: 'reset' });
    const past = Buffer.from(JSON.stringify({ v: 1, e: 'epoch-1', s: 99, c: 'c9' })).toString('base64url');
    expect(pullChanges(db, account, past, PAGE)).toEqual({ kind: 'reset' });
    expect(pullChanges(db, account, 'not-a-cursor', PAGE)).toEqual({ kind: 'reset' });
  });

  it('answers reset when the log was put back from an older copy, whose positions hold other changes now', async () => {
    const { db, dir, path } = fresh();
    const account = newAccount(db);
    pushChanges(db, account.id, [profile('c1', 'Alex')], 1);
    const older = join(dir, 'older.db');
    await backup(db, older);
    pushChanges(db, account.id, [profile('c2', 'Sam'), profile('c3', 'Robin')], 2);
    const page = pullChanges(db, account, undefined, PAGE);
    if (page.kind !== 'changes') throw new Error(page.kind);
    db.close();

    // Put back by hand, without sc-sync restore — the epoch stays, the positions do not.
    const source = new DatabaseSync(older, { readOnly: true });
    await backup(source, path);
    source.close();
    const restored = openDatabase(path);
    pushChanges(restored, account.id, [profile('x2', 'Kim'), profile('x3', 'Lee')], 3);
    expect(pullChanges(restored, account, page.cursor, PAGE)).toEqual({ kind: 'reset' });

    // sc-sync restore renews every epoch, so even a cursor the copy still holds answers reset.
    const early = pullChanges(restored, account, undefined, { count: 1, bytes: PAGE.bytes });
    if (early.kind !== 'changes') throw new Error(early.kind);
    renewEpochs(restored, () => 'epoch-2');
    const renewed = restored.prepare('SELECT epoch FROM accounts WHERE id = ?').get(account.id)?.epoch;
    expect(pullChanges(restored, { ...account, epoch: String(renewed) }, early.cursor, PAGE)).toEqual({ kind: 'reset' });
    restored.close();
  });
});
