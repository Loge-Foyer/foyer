import type { SyncChange } from '@sc/api';
import { afterEach, describe, expect, it } from 'vitest';

import { account, device, profile, pullAll, testServer, type TestServer } from './support/server';

const servers: TestServer[] = [];
const server = () => {
  const created = testServer();
  servers.push(created);
  return created;
};

afterEach(() => {
  for (const created of servers.splice(0)) created.close();
});

describe('the routes', () => {
  it('answers health without a token', async () => {
    const s = server();
    expect((await s.call('GET', '/v1/health')).json).toEqual({ ok: true, version: '0.1.0' });
  });

  // A browser app on another origin calls it with a bearer token; no cookie is ever involved.
  it('lets a page on any origin call it', async () => {
    const s = server();
    const preflight = await s.call('OPTIONS', '/v1/sync/pull', {
      headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers what it does not know, or cannot read, in JSON with a status', async () => {
    const s = server();
    const { token } = await account(s);
    expect(await s.call('GET', '/v1/nothing-here')).toMatchObject({ status: 404, json: { error: 'not-found' } });
    expect(await s.call('POST', '/v1/sync/push', { token, body: '{"changes": ' })).toMatchObject({ status: 400, json: { error: 'invalid' } });
    expect(await s.call('POST', '/v1/sync/push', { token, body: { changes: 'none' } })).toMatchObject({ status: 400 });
    expect(await s.call('GET', '/v1/sync/pull')).toMatchObject({ status: 401, json: { error: 'unauthorized' } });
  });

  it('refuses a body over its limit', async () => {
    const s = server();
    const { token } = await account(s);
    const response = await s.call('POST', '/v1/sync/push', { token, body: JSON.stringify({ changes: ['x'.repeat(9 * 1024 * 1024)] }) });
    expect(response).toMatchObject({ status: 413, json: { error: 'too-large' } });
  });

  it('names the account and the device', async () => {
    const s = server();
    const { token } = await account(s, 'family');
    expect((await s.call('GET', '/v1/status', { token })).json).toMatchObject({ account: { name: 'family' }, device: { name: 'Test Phone' } });
  });
});

describe('syncing over HTTP', () => {
  it('returns what it was pushed, the pusher’s own changes included, and resumes from the cursor', async () => {
    const s = server();
    const { proof, token } = await account(s, 'family');
    const tablet = await device(s, 'family', proof, 'tablet');
    expect((await s.call('POST', '/v1/sync/push', { token, body: { changes: [profile('c1', 'Alex')] } })).json).toEqual({ accepted: ['c1'] });
    const first = await pullAll(s, token);
    expect(first.changes.map((change) => change.id)).toEqual(['c1']);
    await s.call('POST', '/v1/sync/push', { token: tablet, body: { changes: [profile('c2', 'Sam')] } });
    expect((await pullAll(s, token, first.cursor)).changes.map((change) => change.id)).toEqual(['c2']);
    expect((await pullAll(s, tablet)).changes.map((change) => change.id)).toEqual(['c1', 'c2']);
  });

  it('carries sealed passwords and fields it does not know, exactly as sent', async () => {
    const s = server();
    const { token } = await account(s);
    const connection = {
      id: 'c1',
      changedAt: 1,
      entity: 'connection',
      operation: 'upsert',
      data: {
        connectionId: 'home',
        pluginId: 'jellyfin',
        label: 'Home',
        media: true,
        perProfile: 'none',
        fields: { serverUrl: 'http://home:8096' },
        settings: {},
        secretKeys: ['password'],
        sealed: { password: 'v1.a1b2.U2VhbGVkIGJ5IGEgZGV2aWNl' },
      },
      comesLater: [1, 2, 3],
    };
    await s.call('POST', '/v1/sync/push', { token, body: { changes: [connection] } });
    expect((await pullAll(s, token)).changes).toEqual([connection as unknown as SyncChange]);
  });

  it('answers 503 and accepts nothing when it cannot store a push', async () => {
    const s = server();
    const { token } = await account(s);
    s.faults.beforeInsert = (inserted) => {
      if (inserted === 1) throw new Error('disk full');
    };
    const failed = await s.call('POST', '/v1/sync/push', { token, body: { changes: [profile('c1', 'Alex'), profile('c2', 'Sam')] } });
    expect(failed).toMatchObject({ status: 503, json: { error: 'storage' } });
    delete s.faults.beforeInsert;
    expect((await s.call('POST', '/v1/sync/push', { token, body: { changes: [profile('c1', 'Alex'), profile('c2', 'Sam')] } })).json).toEqual({
      accepted: ['c1', 'c2'],
    });
    expect((await pullAll(s, token)).changes.map((change) => change.id)).toEqual(['c1', 'c2']);
  });

  it('answers reset for a cursor from another log', async () => {
    const s = server();
    const { token } = await account(s);
    expect((await s.call('GET', '/v1/sync/pull?cursor=bm90IGEgY3Vyc29y', { token })).json).toEqual({ kind: 'reset' });
  });

  it('keeps one account’s devices away from another’s', async () => {
    const s = server();
    const family = await account(s, 'family');
    const friends = await account(s, 'friends');
    const theirs = (await s.call('GET', '/v1/devices', { token: friends.token })).json?.devices as { id: string }[];
    expect((await s.call('DELETE', `/v1/devices/${theirs[0]?.id}`, { token: family.token })).status).toBe(404);
    await s.call('POST', '/v1/sync/push', { token: family.token, body: { changes: [profile('c1', 'Alex')] } });
    expect((await pullAll(s, friends.token)).changes).toEqual([]);
  });
});
