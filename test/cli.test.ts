import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { openDatabase } from '../src/store/db';
import { profile, signUp } from './support/server';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sc-sync-cli-'));
  dirs.push(dir);
  return dir;
}

function cli(dir: string, ...args: string[]) {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: { ...process.env, SC_SYNC_DATA: dir },
    encoding: 'utf8',
  });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

/** The server, in this process, on the same data directory the command line works on. */
function serverOn(dir: string) {
  const db = openDatabase(join(dir, 'sync.db'));
  const app = createApp({ db, now: Date.now, random: randomBytes, clientAddress: () => '203.0.113.7', logger: silentLogger });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { db, call };
}

describe('sc-sync', () => {
  it('makes an invite the app can create an account with', async () => {
    const dir = dataDir();
    const invite = cli(dir, 'invite', '--expires', '1h');
    expect(invite.code).toBe(0);
    expect(invite.out).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const server = serverOn(dir);
    expect((await server.call('POST', '/v1/accounts', signUp(invite.out, 'family').body)).status).toBe(200);
    server.db.close();
    expect(cli(dir, 'accounts').out).toMatch(/^family {2}1 device {2}0 changes/);
  });

  it('lists an account’s devices, and revokes one', async () => {
    const dir = dataDir();
    const server = serverOn(dir);
    const created = await server.call('POST', '/v1/accounts', signUp(cli(dir, 'invite').out, 'family').body);
    const token = String(created.json?.token);
    const id = String((created.json?.device as { id: string }).id);
    expect(cli(dir, 'devices', 'family').out).toContain(id);
    expect(cli(dir, 'revoke', id).code).toBe(0);
    expect((await server.call('GET', '/v1/status', undefined, token)).status).toBe(401);
    expect(cli(dir, 'revoke', id).code).toBe(1);
    server.db.close();
  });

  it('deletes an account only when told so twice', async () => {
    const dir = dataDir();
    const server = serverOn(dir);
    await server.call('POST', '/v1/accounts', signUp(cli(dir, 'invite').out, 'family').body);
    server.db.close();
    expect(cli(dir, 'delete-account', 'family').code).toBe(1);
    expect(cli(dir, 'delete-account', 'family', '--yes').code).toBe(0);
    expect(cli(dir, 'accounts').out).toContain('No accounts yet');
  });

  it('refuses an unknown command or a bad expiry', () => {
    const dir = dataDir();
    expect(cli(dir, 'nonsense').code).toBe(1);
    expect(cli(dir, 'invite', '--expires', 'forever').code).toBe(1);
  });

  it('backs up while running, and restores so that every device joins again', async () => {
    const dir = dataDir();
    const backupFile = join(dir, 'backup.db');
    let server = serverOn(dir);
    const token = String((await server.call('POST', '/v1/accounts', signUp(cli(dir, 'invite').out, 'family').body)).json?.token);
    await server.call('POST', '/v1/sync/push', { changes: [profile('c1', 'Alex')] }, token);
    const before = await server.call('GET', '/v1/sync/pull', undefined, token);
    expect(cli(dir, 'backup', backupFile).code).toBe(0);
    await server.call('POST', '/v1/sync/push', { changes: [profile('c2', 'Sam')] }, token);

    // A write-ahead log left behind from after the backup: a file copied back over the database would replay it.
    const stale = join(dir, 'stale-wal');
    copyFileSync(join(dir, 'sync.db-wal'), stale);
    server.db.close();
    copyFileSync(stale, join(dir, 'sync.db-wal'));

    const restored = cli(dir, 'restore', backupFile);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('Restored 1 account');

    server = serverOn(dir);
    const after = await server.call('GET', '/v1/sync/pull', undefined, token);
    expect(after.json?.kind).toBe('changes');
    expect((after.json?.changes as { id: string }[]).map((change) => change.id)).toEqual(['c1']);
    // Any cursor from before the restore belongs to a log that is gone.
    expect((await server.call('GET', `/v1/sync/pull?cursor=${String(before.json?.cursor)}`, undefined, token)).json).toEqual({ kind: 'reset' });
    server.db.close();
  });

  it('will not restore under a running server', () => {
    const dir = dataDir();
    const backupFile = join(dir, 'backup.db');
    cli(dir, 'invite');
    expect(cli(dir, 'backup', backupFile).code).toBe(0);
    writeFileSync(join(dir, 'server.lock'), String(process.pid));
    const refused = cli(dir, 'restore', backupFile);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('The server is running');
    // A lock left by a crash names no live process.
    writeFileSync(join(dir, 'server.lock'), '999999');
    expect(cli(dir, 'restore', backupFile).code).toBe(0);
    expect(existsSync(join(dir, 'sync.db'))).toBe(true);
  });
});
