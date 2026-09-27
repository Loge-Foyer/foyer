import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { account, DAY, device, dump, signUp, testServer, type TestServer } from './support/server';

const servers: TestServer[] = [];
const server = () => {
  const created = testServer();
  servers.push(created);
  return created;
};

afterEach(() => {
  for (const created of servers.splice(0)) created.close();
});

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const login = (s: TestServer, username: string, proof: Buffer, installation = 'install-x') =>
  s.call('POST', '/v1/auth/login', { body: { username, proof: b64(proof), installation, deviceName: 'Phone' } });

describe('parameters', () => {
  it('shows a name no account has the same kind of parameters, the same each time', async () => {
    const s = server();
    await account(s, 'family');
    const known = await s.call('POST', '/v1/auth/params', { body: { username: 'family' } });
    const unknown = await s.call('POST', '/v1/auth/params', { body: { username: 'nobody' } });
    const again = await s.call('POST', '/v1/auth/params', { body: { username: 'nobody' } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(Object.keys(unknown.json?.kdf as object).sort()).toEqual(Object.keys(known.json?.kdf as object).sort());
    expect(unknown.json?.kdf).toMatchObject({ algorithm: 'pbkdf2-sha256', iterations: 600_000 });
    expect(again.json).toEqual(unknown.json);
  });

  it('treats a username however it was typed as one account', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    expect((await login(s, 'FAMILY', proof)).status).toBe(200);
  });
});

describe('signing in', () => {
  it('signs in with the right proof, and refuses a wrong one or a name no account has alike', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    const ok = await login(s, 'family', proof);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ account: { name: 'family' } });
    expect(typeof ok.json?.vault).toBe('string');
    const wrong = await login(s, 'family', randomBytes(32));
    const nobody = await login(s, 'nobody', randomBytes(32));
    expect([wrong.status, nobody.status]).toEqual([401, 401]);
    expect(wrong.json).toEqual(nobody.json);
  });

  it('keeps one row per installation: signing in again replaces its token', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    const first = String((await login(s, 'family', proof, 'phone')).json?.token);
    const second = String((await login(s, 'family', proof, 'phone')).json?.token);
    expect((await s.call('GET', '/v1/status', { token: first })).status).toBe(401);
    expect((await s.call('GET', '/v1/status', { token: second })).status).toBe(200);
    const devices = (await s.call('GET', '/v1/devices', { token: second })).json?.devices as unknown[];
    expect(devices).toHaveLength(2);
  });

  it('stores neither a token nor a proof', async () => {
    const s = server();
    const { proof, token } = await account(s, 'family');
    const other = await device(s, 'family', proof, 'tablet');
    const everything = dump(s.db);
    for (const secret of [token, other, b64(proof)]) expect(everything).not.toContain(secret);
  });

  it('refuses a revoked device, and every call after', async () => {
    const s = server();
    const { proof, token } = await account(s, 'family');
    const tablet = await device(s, 'family', proof, 'tablet');
    const devices = (await s.call('GET', '/v1/devices', { token })).json?.devices as { id: string; current: boolean }[];
    const other = devices.find((entry) => !entry.current);
    expect((await s.call('DELETE', `/v1/devices/${other?.id}`, { token })).status).toBe(204);
    expect((await s.call('GET', '/v1/sync/pull', { token: tablet })).status).toBe(401);
    expect((await s.call('GET', '/v1/sync/pull', { token })).status).toBe(200);
  });

  it('lets a device go on logout', async () => {
    const s = server();
    const { token } = await account(s, 'family');
    expect((await s.call('POST', '/v1/auth/logout', { token })).status).toBe(204);
    expect((await s.call('GET', '/v1/status', { token })).status).toBe(401);
  });
});

describe('throttling', () => {
  it('makes a name wait after five misses from one address, doubling, and forgets them on a success', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    for (let miss = 0; miss < 4; miss += 1) expect((await login(s, 'family', randomBytes(32))).status).toBe(401);
    expect((await login(s, 'family', randomBytes(32))).status).toBe(401);
    const locked = await login(s, 'family', proof);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('30');
    s.advance(30_000);
    expect((await login(s, 'family', randomBytes(32))).status).toBe(401);
    expect((await login(s, 'family', proof)).headers.get('retry-after')).toBe('60');
    s.advance(60_000);
    expect((await login(s, 'family', proof)).status).toBe(200);
    expect((await login(s, 'family', randomBytes(32))).status).toBe(401);
  });

  it('never keeps the owner out from another address', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    s.setAddress('198.51.100.9');
    for (let miss = 0; miss < 6; miss += 1) await login(s, 'family', randomBytes(32));
    expect((await login(s, 'family', proof)).status).toBe(429);
    s.setAddress('203.0.113.7');
    expect((await login(s, 'family', proof)).status).toBe(200);
  });

  it('makes an address wait that misses on many names', async () => {
    const s = server();
    const { proof } = await account(s, 'family');
    s.setAddress('198.51.100.9');
    for (let miss = 0; miss < 20; miss += 1) await login(s, `name${miss}`, randomBytes(32));
    expect((await login(s, 'family', proof)).status).toBe(429);
  });

  it('counts guesses at verify per device', async () => {
    const s = server();
    const { proof, token } = await account(s, 'family');
    const tablet = await device(s, 'family', proof, 'tablet');
    for (let miss = 0; miss < 5; miss += 1) {
      expect((await s.call('POST', '/v1/auth/verify', { token, body: { proof: b64(randomBytes(32)) } })).status).toBe(403);
    }
    expect((await s.call('POST', '/v1/auth/verify', { token, body: { proof: b64(proof) } })).status).toBe(429);
    expect((await s.call('POST', '/v1/auth/verify', { token: tablet, body: { proof: b64(proof) } })).status).toBe(204);
  });
});

describe('verifying the owner', () => {
  it('answers 204 for the right proof, 403 for a wrong one, and 401 to a device it does not know', async () => {
    const s = server();
    const { proof, token } = await account(s, 'family');
    expect((await s.call('POST', '/v1/auth/verify', { token, body: { proof: b64(proof) } })).status).toBe(204);
    expect((await s.call('POST', '/v1/auth/verify', { token, body: { proof: b64(randomBytes(32)) } })).status).toBe(403);
    expect((await s.call('POST', '/v1/auth/verify', { token: 'nobody', body: { proof: b64(proof) } })).status).toBe(401);
  });
});

describe('invites', () => {
  it('create one account each, then are spent', async () => {
    const s = server();
    const invite = s.invite();
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'family').body })).status).toBe(200);
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'friends').body })).json).toEqual({ error: 'invite' });
  });

  it('take a code however it was typed', async () => {
    const s = server();
    const invite = s.invite().toLowerCase().replace(/-/g, ' ');
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'family').body })).status).toBe(200);
  });

  it('expire', async () => {
    const s = server();
    const invite = s.invite(DAY);
    s.advance(DAY + 1);
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'family').body })).status).toBe(403);
  });

  it('are checked before the name, and a taken name spends none', async () => {
    const s = server();
    await account(s, 'family');
    expect((await s.call('POST', '/v1/accounts', { body: signUp('0000-0000-0000', 'family').body })).json).toEqual({ error: 'invite' });
    const invite = s.invite();
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'family').body })).status).toBe(409);
    expect((await s.call('POST', '/v1/accounts', { body: signUp(invite, 'friends').body })).status).toBe(200);
  });

  it('refuse parameters weaker or heavier than a device derives', async () => {
    const s = server();
    for (const kdf of [
      { algorithm: 'pbkdf2-sha256', iterations: 1_000, salt: b64(randomBytes(16)) },
      { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: b64(randomBytes(4)) },
      { algorithm: 'scrypt', iterations: 600_000, salt: b64(randomBytes(16)) },
    ]) {
      expect((await s.call('POST', '/v1/accounts', { body: signUp(s.invite(), 'family', { kdf }).body })).status).toBe(400);
    }
  });

  it('are throttled per address', async () => {
    const s = server();
    for (let miss = 0; miss < 5; miss += 1) await s.call('POST', '/v1/accounts', { body: signUp('0000-0000-0000', 'family').body });
    expect((await s.call('POST', '/v1/accounts', { body: signUp(s.invite(), 'family').body })).status).toBe(429);
  });
});
