import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { SyncChange } from '@sc/api';

import { inviteHash, newInviteCode } from '../../src/auth/invites';
import { openDatabase } from '../../src/store/db';
import { insertInvite } from '../../src/store/invites';
import { signUp } from './server';

const DIST = join(import.meta.dirname, '..', '..', 'dist');

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** The bundle the image ships, as its own process — so a crash is a real one. */
export async function startServer(dataDir: string, port: number, env: Readonly<Record<string, string>> = {}) {
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(DIST, 'main.mjs')], {
    env: { ...process.env, SC_SYNC_DATA: dataDir, SC_SYNC_PORT: String(port), SC_SYNC_HOST: '127.0.0.1', ...env },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    base,
    exited,
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** An invite written straight into the database, as `sc-sync invite` does. */
export function inviteInto(dataDir: string): string {
  const db = openDatabase(join(dataDir, 'sync.db'));
  const code = newInviteCode(randomBytes);
  const hash = inviteHash(code);
  if (!hash) throw new Error('invite');
  insertInvite(db, hash, Date.now(), Date.now() + 86_400_000);
  db.close();
  return code;
}

export async function createAccount(base: string, invite: string, username = 'family') {
  const response = await fetch(`${base}/v1/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signUp(invite, username).body),
  });
  if (!response.ok) throw new Error(`account: ${response.status}`);
  return String(((await response.json()) as { token: string }).token);
}

export async function push(base: string, token: string, changes: readonly SyncChange[]) {
  const response = await fetch(`${base}/v1/sync/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ changes }),
  });
  return (await response.json()) as { accepted: string[] };
}

export async function pullIds(base: string, token: string): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await fetch(`${base}/v1/sync/pull${cursor ? `?cursor=${cursor}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    const page = (await response.json()) as { kind: string; changes: SyncChange[]; cursor: string; more: boolean };
    if (page.kind !== 'changes') throw new Error(page.kind);
    ids.push(...page.changes.map((change) => change.id));
    cursor = page.cursor;
    if (!page.more) return ids;
  }
}
