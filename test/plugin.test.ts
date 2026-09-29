// The real custom-server plugin, driven against the real server in-process:
// the one place the client and the server meet before a device does. The
// plugin is imported from its source for this test alone — src/ never does.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AppError, connectionId, userId, type ConnectedUserStateSyncProvider, type SyncChange } from '@sc/api';
import { plugin } from '@sc/sync-custom-server';
import { afterEach, describe, expect, it } from 'vitest';

import { hostContext, inProcessHttp } from './support/host';
import { dump, testServer, type TestServer } from './support/server';

const BASE = 'http://sync.test';
const PASSWORD = 'the household password';
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs');

const servers: TestServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function started() {
  const server = testServer();
  servers.push(server);
  return { server, http: inProcessHttp(server.app) };
}

type Http = ReturnType<typeof inProcessHttp>;

/** One device signed in — or about to be — as `family`. */
async function device(http: Http, name: string, options: { password?: string; session?: string | undefined } = {}) {
  const host = hostContext({
    http: http.client,
    password: options.password ?? PASSWORD,
    installationId: `install-${name}`,
    ...(options.session === undefined ? {} : { session: options.session }),
  });
  const sync = plugin.sync;
  if (!sync) throw new Error('custom-server has no sync role');
  const provider: ConnectedUserStateSyncProvider = await sync.connect(
    { connectionId: connectionId(`account-${name}`), fields: { serverUrl: BASE, username: 'Family' }, settings: {} },
    host.context,
  );
  return { provider, host };
}

const change = (id: string, name: string): SyncChange => ({
  id,
  changedAt: 1,
  entity: 'profile',
  operation: 'upsert',
  data: { userId: userId(`u-${name.toLowerCase()}`), name },
});

async function pulledIds(provider: ConnectedUserStateSyncProvider) {
  const ids: string[] = [];
  let cursor;
  for (;;) {
    const page = await provider.pull(cursor);
    if (page.kind !== 'changes') throw new Error(`pull answered ${page.kind}`);
    ids.push(...page.changes.map((pulled) => pulled.id));
    cursor = page.cursor;
    if (!page.more) return ids;
  }
}

const failure = async (work: Promise<unknown> | undefined) => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('It did not fail.');
};

describe('the custom-server plugin against the server', () => {
  it('creates an account from an invite, and a second device signed in to it holds the same vault key', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    expect(await phone.provider.createAccount?.({ invite: server.invite().toLowerCase() })).toEqual({ accountName: 'family on sync.test' });
    const browser = await device(http, 'browser');
    expect(await browser.provider.getStatus()).toEqual({ accountName: 'family on sync.test' });
    const key = await browser.provider.vaultKey?.();
    expect(key).toHaveLength(32);
    expect(key).toEqual(await phone.provider.vaultKey?.());

    // Nothing the server keeps would sign anyone in or open anything.
    const login = http.to('POST /v1/auth/login')[0];
    const proof = String((JSON.parse(login?.request.body ?? '{}') as { proof?: string }).proof);
    const token = String((JSON.parse(login?.text ?? '{}') as { token?: string }).token);
    const kept = dump(server.db);
    for (const secret of [PASSWORD, proof, token, Buffer.from(key ?? new Uint8Array()).toString('base64url')]) {
      expect(kept).not.toContain(secret);
    }
    expect(http.exchanges.some((exchange) => JSON.stringify(exchange.request).includes(PASSWORD))).toBe(false);
  });

  it('keeps two devices in step: one order for both, and each sees its own changes come back', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite: server.invite() });
    const browser = await device(http, 'browser');
    expect(await phone.provider.push([change('p1', 'Alex')])).toEqual({ accepted: ['p1'] });
    expect(await browser.provider.push([change('b1', 'Sam'), change('p1', 'Alex')])).toEqual({ accepted: ['b1', 'p1'] });
    expect(await pulledIds(phone.provider)).toEqual(['p1', 'b1']);
    expect(await pulledIds(browser.provider)).toEqual(['p1', 'b1']);
  });

  it('carries a sealed password exactly as it was sent', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite: server.invite() });
    const sealed: SyncChange = {
      id: 'c1',
      changedAt: 1,
      entity: 'connection',
      operation: 'upsert',
      data: {
        connectionId: connectionId('home'),
        pluginId: 'jellyfin' as never,
        label: 'Home',
        media: true,
        perProfile: 'none',
        fields: { serverUrl: 'http://home:8096', username: 'family' },
        settings: {},
        secretKeys: ['password'],
        sealed: { password: 'v1.AbCdEf.bm90LXJlYWxseS1zZWFsZWQ' },
      },
    };
    await phone.provider.push([sealed]);
    const browser = await device(http, 'browser');
    const page = await browser.provider.pull(undefined);
    expect(page.kind === 'changes' && page.changes).toEqual([sealed]);
  });

  it('checks the owner: right, wrong, then throttled — and waits, rather than locking anyone out', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite: server.invite() });
    await expect(phone.provider.verifyOwner?.({ password: PASSWORD })).resolves.toBeUndefined();
    for (let miss = 0; miss < 5; miss += 1) {
      expect(await failure(phone.provider.verifyOwner?.({ password: 'not the password' }))).toMatchObject({ code: 'UNAUTHORIZED' });
    }
    const throttled = await failure(phone.provider.verifyOwner?.({ password: PASSWORD }));
    expect(throttled).toBeInstanceOf(AppError);
    expect(throttled).toMatchObject({ code: 'UNAUTHORIZED', reason: 'too-many-attempts' });
    // Throttled per device: another device of the account is not.
    const browser = await device(http, 'browser');
    await expect(browser.provider.verifyOwner?.({ password: PASSWORD })).resolves.toBeUndefined();
    server.advance(31_000);
    await expect(phone.provider.verifyOwner?.({ password: PASSWORD })).resolves.toBeUndefined();
  });

  it('stops at sc-sync revoke, and never signs itself back in — after a relaunch either', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite: server.invite() });
    await phone.provider.push([change('p1', 'Alex')]);
    const id = String(server.db.prepare("SELECT id FROM devices WHERE installation = 'install-phone'").get()?.id);
    const revoked = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'revoke', id], {
      env: { ...process.env, SC_SYNC_DATA: dirname(server.path) },
      encoding: 'utf8',
    });
    expect(revoked.status).toBe(0);

    expect(await failure(phone.provider.pull(undefined))).toMatchObject({ code: 'UNAUTHORIZED', reason: 'signed-out' });
    const asked = http.exchanges.length;
    const relaunched = await device(http, 'phone', { session: phone.host.session() });
    expect(await failure(relaunched.provider.getStatus())).toMatchObject({ reason: 'signed-out' });
    expect(await failure(relaunched.provider.push([change('p2', 'Sam')]))).toMatchObject({ reason: 'signed-out' });
    expect(http.exchanges.length).toBe(asked);
    expect(http.to('POST /v1/auth/login')).toHaveLength(0);
  });

  it('signs out: the server lets this device go, and keeps the others', async () => {
    const { server, http } = started();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite: server.invite() });
    const browser = await device(http, 'browser');
    await browser.provider.getStatus();
    await phone.provider.signOut?.();
    const installations = server.db.prepare('SELECT installation FROM devices ORDER BY installation').all().map((row) => String(row.installation));
    expect(installations).toEqual(['install-browser']);
    await expect(browser.provider.pull(undefined)).resolves.toMatchObject({ kind: 'changes' });
  });

  it('refuses a wrong password once, and a used invite in words', async () => {
    const { server, http } = started();
    const invite = server.invite();
    const phone = await device(http, 'phone');
    await phone.provider.createAccount?.({ invite });
    const intruder = await device(http, 'intruder', { password: 'a guess at the password' });
    expect(await failure(intruder.provider.getStatus())).toMatchObject({ code: 'UNAUTHORIZED', retry: 'never' });
    expect(await failure(intruder.provider.pull(undefined))).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(http.to('POST /v1/auth/login')).toHaveLength(1);
    const again = await device(http, 'again');
    expect(await failure(again.provider.createAccount?.({ invite }))).toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/invite/) });
  });
});

it('keeps the plugin out of the server itself: only this test imports it', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
  const offending = files(join(import.meta.dirname, '..', 'src')).filter((file) => readFileSync(file, 'utf8').includes('@sc/plugin-'));
  expect(offending).toEqual([]);
});
