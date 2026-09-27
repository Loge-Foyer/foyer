import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncChange } from '@sc/api';

import { createApp } from '../../src/app';
import { inviteHash, newInviteCode } from '../../src/auth/invites';
import { silentLogger } from '../../src/logger';
import type { Faults } from '../../src/store/changes';
import { openDatabase, type Database } from '../../src/store/db';
import { insertInvite } from '../../src/store/invites';

export const DAY = 86_400_000;

/** A server on a fresh database file, with its clock, its callers' address and its failures in the test's hands. */
export function testServer() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-sync-'));
  const path = join(dir, 'sync.db');
  let now = 1_800_000_000_000;
  let address = '203.0.113.7';
  const faults: { beforeInsert?: Faults['beforeInsert']; afterCommit?: Faults['afterCommit'] } = {};
  const db = openDatabase(path);
  const app = createApp({
    db,
    now: () => now,
    random: randomBytes,
    clientAddress: () => address,
    logger: silentLogger,
    faults: { beforeInsert: (inserted) => faults.beforeInsert?.(inserted), afterCommit: () => faults.afterCommit?.() },
  });

  const call = async (method: string, path: string, options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };

  return {
    app,
    db,
    path,
    dir,
    faults,
    call,
    advance: (ms: number) => {
      now += ms;
    },
    setAddress: (next: string) => {
      address = next;
    },
    /** An invite, as `sc-sync invite` would make one. */
    invite: (expiresIn = 7 * DAY) => {
      const code = newInviteCode(randomBytes);
      const hash = inviteHash(code);
      if (!hash) throw new Error('invite');
      insertInvite(db, hash, now, now + expiresIn);
      return code;
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestServer = ReturnType<typeof testServer>;

const b64 = (bytes: Buffer) => bytes.toString('base64url');

/** What a device sends to create an account: the server interprets none of it but the proof's length. */
export function signUp(invite: string, username: string, overrides: Record<string, unknown> = {}) {
  const proof = randomBytes(32);
  return {
    proof,
    body: {
      invite,
      username,
      kdf: { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: b64(randomBytes(16)) },
      proof: b64(proof),
      vault: b64(randomBytes(60)),
      installation: `install-${username}`,
      deviceName: 'Test Phone',
      ...overrides,
    },
  };
}

/** An account and a signed-in device on it. */
export async function account(server: TestServer, username = 'family') {
  const { proof, body } = signUp(server.invite(), username);
  const created = await server.call('POST', '/v1/accounts', { body });
  if (created.status !== 200) throw new Error(`account: ${created.status} ${created.text}`);
  return { proof, token: String(created.json?.token), created };
}

/** Another device of the same account, signed in with its proof. */
export async function device(server: TestServer, username: string, proof: Buffer, installation: string) {
  const login = await server.call('POST', '/v1/auth/login', {
    body: { username, proof: b64(proof), installation, deviceName: installation },
  });
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`);
  return String(login.json?.token);
}

export function profile(id: string, name: string): SyncChange {
  return { id, changedAt: 1, entity: 'profile', operation: 'upsert', data: { userId: `u-${name.toLowerCase()}` as never, name } };
}

/** Every change a token's account holds, page by page from the start. */
export async function pullAll(server: TestServer, token: string, from?: string) {
  const changes: SyncChange[] = [];
  let cursor = from;
  for (;;) {
    const page = await server.call('GET', `/v1/sync/pull${cursor === undefined ? '' : `?cursor=${cursor}`}`, { token });
    if (page.json?.kind !== 'changes') return { kind: String(page.json?.kind), changes, cursor };
    changes.push(...(page.json.changes as SyncChange[]));
    cursor = String(page.json.cursor);
    if (page.json.more !== true) return { kind: 'changes', changes, cursor };
  }
}

export function dump(db: Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
  return tables
    .map((table) =>
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row, (_, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString('base64url') : value)))
        .join('\n'),
    )
    .join('\n');
}
