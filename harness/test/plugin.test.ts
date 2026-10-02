// The real sync/custom-server plugin — the one the app ships — against the
// real binary. The Go tests prove the server's rules by calling its API; this
// proves the plugin and the server agree on every one of them.
import { connectionId, pluginId, recordKey, userId, type AccountRecord, type ConnectionId, type UserId } from '@loge/api';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { device, SIGN_IN, type Device } from './support/host';
import { startServer, type Server, type ServerOptions } from './support/server';

const PASSWORD = 'correct horse battery staple';

const sam = userId('0f7c2d4e-5a1b-4c3d-9e8f-1a2b3c4d5e6f');
const robin = userId('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
const kim = userId('2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e');
const home = connectionId('3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f');

const profile = (id: UserId, name: string): AccountRecord => ({ kind: 'profile', key: id, deleted: false, data: { userId: id, name } });
const pin = (id: UserId, value: string | null): AccountRecord => ({ kind: 'pin', key: id, deleted: false, data: { userId: id, pin: value } });
const preference = (id: UserId, name: string, value: unknown): AccountRecord => ({
  kind: 'preference',
  key: `${id}/${name}`,
  deleted: false,
  data: { userId: id, name, value },
});
const connection = (id: ConnectionId, options: { readonly label?: string; readonly password?: string } = {}): AccountRecord => ({
  kind: 'connection',
  key: id,
  deleted: false,
  data: {
    connectionId: id,
    pluginId: pluginId('sources/jellyfin'),
    label: options.label ?? 'Home',
    enabled: true,
    perProfile: 'credentials',
    fields: { serverUrl: 'http://home:8096', localOnly: true },
    settings: { libraries: { mode: 'only', ids: ['films'] } },
    secretKeys: ['password'],
    secrets: options.password === undefined ? {} : { password: options.password },
  },
});
const subscription = (id: string, user: UserId, connection: ConnectionId, channel: string, title: string): AccountRecord => ({
  kind: 'subscription',
  key: id,
  deleted: false,
  data: { subscriptionId: id, userId: user, connectionId: connection, externalId: channel, title, addedAt: '2026-10-01T12:00:00.000Z' },
});
const favorite = (id: string, user: UserId, connection: ConnectionId, channel: string, name: string, extra: { number?: number; logo?: string } = {}): AccountRecord => ({
  kind: 'favoriteChannel',
  key: id,
  deleted: false,
  data: { favoriteId: id, userId: user, connectionId: connection, externalId: channel, name, ...extra, addedAt: '2026-10-02T12:00:00.000Z' },
});
const playlist = (id: string, user: UserId, title: string, items: readonly { connectionId: ConnectionId; externalId: string }[]): AccountRecord => ({
  kind: 'playlist',
  key: id,
  deleted: false,
  data: { playlistId: id, userId: user, title, items, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' },
});
const profileValues = (id: ConnectionId, user: UserId, password?: string): AccountRecord => ({
  kind: 'profileValues',
  key: `${id}/${user}`,
  deleted: false,
  data: {
    connectionId: id,
    userId: user,
    off: false,
    fields: { username: 'sam' },
    settings: {},
    secretKeys: ['password'],
    secrets: password === undefined ? {} : { password },
  },
});
const tombstone = (kind: AccountRecord['kind'], key: string) => ({ kind, key, deleted: true }) as AccountRecord;

const byIdentity = (records: readonly AccountRecord[]) => new Map(records.map((record) => [`${record.kind}/${record.key}`, record]));

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function serve(options: ServerOptions = {}) {
  const server = await startServer(options);
  servers.push(server);
  return server;
}

/** A device that made the account with an invite: the sign-up's session is its own. */
async function signedUp(server: Server, options: { readonly firstProfile?: boolean } = {}): Promise<Device & { readonly accountId: string }> {
  const created = await device(server, { name: 'a', username: 'sam', password: PASSWORD });
  const status = await created.account.createAccount?.({ invite: await server.invite() }, { firstProfile: options.firstProfile ?? false });
  if (!status) throw new Error('The plugin cannot create an account.');
  return { ...created, accountId: status.accountId };
}

describe('the real plugin against the real server', () => {
  it('signs up with an invite; a second device signs in, and each reads what the other wrote', async () => {
    const server = await serve();
    const a = await device(server, { name: 'a', username: 'sam', password: PASSWORD });
    // Read without a session: the limit and how the server takes accounts.
    expect(await a.account.info()).toEqual({ serverVersion: inject('appVersion'), maxProfiles: 10, signUp: 'invite' });
    const created = await a.account.createAccount?.({ invite: await server.invite() }, { firstProfile: false });
    expect(created).toMatchObject({ accountName: expect.stringContaining('sam on ') });

    const written = [
      profile(sam, 'Sam'),
      pin(sam, '1234'),
      preference(sam, 'homeLayout', { version: 1, rows: [{ id: 'continue', type: 'continue', hidden: true }] }),
      connection(home, { password: 'family-secret' }),
      profileValues(home, sam, 'sam-secret'),
    ];
    expect(await a.account.push(written)).toEqual({ kind: 'stored' });

    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    expect((await b.account.status()).accountId).toBe(created?.accountId);
    const read = byIdentity((await b.account.pull()).records);
    expect(read.size).toBe(written.length);
    for (const record of written) expect(read.get(`${record.kind}/${record.key}`)).toEqual(record);

    expect(await b.account.push([profile(sam, 'Sam, renamed on B'), pin(sam, null)])).toEqual({ kind: 'stored' });
    const back = byIdentity((await a.account.pull()).records);
    expect(back.get(`profile/${sam}`)).toEqual(profile(sam, 'Sam, renamed on B'));
    expect(back.get(`pin/${sam}`)).toEqual(pin(sam, null));

    // The sign-up's session was A's own; B signed in once.
    expect(a.http.count(SIGN_IN)).toBe(0);
    expect(b.http.count(SIGN_IN)).toBe(1);
  });

  it('carries a profile’s own lists between devices, and a delete stays deleted', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const subId = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a';
    const listId = '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b';

    // Parents first, as a batch must send them.
    expect(
      await a.account.push([
        profile(sam, 'Sam'),
        connection(home),
        subscription(subId, sam, home, 'UCuAXFkgsw1L7xaCfnd5JJOw', 'Some Channel'),
        playlist(listId, sam, 'Things worth rewatching', [
          { connectionId: home, externalId: 'dQw4w9WgXcQ' },
          { connectionId: home, externalId: 'm-arrival' },
        ]),
      ]),
    ).toEqual({ kind: 'stored' });

    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    const read = byIdentity((await b.account.pull()).records);
    expect(read.get(`subscription/${subId}`)).toEqual(subscription(subId, sam, home, 'UCuAXFkgsw1L7xaCfnd5JJOw', 'Some Channel'));
    expect(read.get(`playlist/${listId}`)).toEqual(
      playlist(listId, sam, 'Things worth rewatching', [
        { connectionId: home, externalId: 'dQw4w9WgXcQ' },
        { connectionId: home, externalId: 'm-arrival' },
      ]),
    );

    // A list is edited as a whole, and the last push wins.
    expect(await b.account.push([playlist(listId, sam, 'Renamed on B', [{ connectionId: home, externalId: 'dQw4w9WgXcQ' }])])).toEqual({
      kind: 'stored',
    });
    // Unfollowed on B: a tombstone carries no data, and no parent with it.
    expect(await b.account.push([{ kind: 'subscription', key: subId, deleted: true }])).toEqual({ kind: 'stored' });

    const back = byIdentity((await a.account.pull()).records);
    expect(back.get(`playlist/${listId}`)).toMatchObject({ data: { title: 'Renamed on B', items: [{ externalId: 'dQw4w9WgXcQ' }] } });
    expect(back.get(`subscription/${subId}`)).toEqual({ kind: 'subscription', key: subId, deleted: true });
  });

  it('carries a profile’s favourite channels between devices, number, logo and all — or neither', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const first = '6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c';
    const second = '7a8b9c0d-1e2f-4a3b-8c4d-6e7f8a9b0c1d';
    const ard = favorite(first, sam, home, 'ch:101', 'Das Erste', { number: 1, logo: 'http://portal.test/stalker_portal/misc/logos/320/101.png' });
    // A Stalker series' id holds a colon, encoded: the id is the source's, and may hold anything but a slash.
    const plain = favorite(second, sam, home, 'ch:18390%3A1', 'No number, no logo');
    expect(await a.account.push([profile(sam, 'Sam'), connection(home), ard, plain])).toEqual({ kind: 'stored' });

    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    const read = byIdentity((await b.account.pull()).records);
    expect(read.get(`favoriteChannel/${first}`)).toEqual(ard);
    // PocketBase has no null: no number and no logo come back as nothing at all.
    expect(read.get(`favoriteChannel/${second}`)).toEqual(plain);

    // Removed on B: a tombstone carries no data, and the other stays.
    expect(await b.account.push([{ kind: 'favoriteChannel', key: first, deleted: true }])).toEqual({ kind: 'stored' });
    const back = byIdentity((await a.account.pull()).records);
    expect(back.get(`favoriteChannel/${first}`)).toEqual({ kind: 'favoriteChannel', key: first, deleted: true });
    expect(back.get(`favoriteChannel/${second}`)).toEqual(plain);
  });

  it('carries where a profile got to, every field of it — and nothing where nothing was said — and the account’s own settings', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const watched = (data: Extract<AccountRecord, { kind: 'watchProgress'; deleted: false }>['data']): AccountRecord => ({
      kind: 'watchProgress',
      key: recordKey('watchProgress', data),
      deleted: false,
      data,
    });
    const film = watched({
      userId: sam,
      identity: 'tmdb:movie:603',
      externalIds: { tmdb: '603', imdb: 'tt0133093' },
      round: 1,
      watched: false,
      positionMs: 1_234_000,
      durationMs: 8_160_000,
      item: { type: 'movie', key: { connectionId: home, externalId: 'vod:11' }, title: 'Matrix (1999) DE', ratings: {}, genres: [], images: {} },
      createdAt: '2026-10-01T20:00:00.000Z',
      updatedAt: '2026-10-02T21:15:00.000Z',
    });
    // Watched, and nothing else said: no position, no ids, no snapshot.
    const video = watched({ userId: sam, identity: 'youtube:dQw4w9WgXcQ', round: 0, watched: true, createdAt: '2026-10-01T20:00:00.000Z', updatedAt: '2026-10-01T20:03:33.000Z' });
    const setting: AccountRecord = { kind: 'setting', key: 'watchStatus', deleted: false, data: { name: 'watchStatus', value: { media: false, videos: true, tv: true } } };
    expect(await a.account.push([profile(sam, 'Sam'), film, video, setting])).toEqual({ kind: 'stored' });

    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    const read = byIdentity((await b.account.pull()).records);
    expect(read.get(`watchProgress/${film.key}`)).toEqual(film);
    // PocketBase has no null: what was left out comes back left out.
    expect(read.get(`watchProgress/${video.key}`)).toEqual(video);
    expect(read.get('setting/watchStatus')).toEqual(setting);

    // Marked unwatched on B: a new round, stored as it was sent — the client merges, never the server.
    const again = watched({ userId: sam, identity: 'tmdb:movie:603', round: 2, watched: false, createdAt: '2026-10-01T20:00:00.000Z', updatedAt: '2026-10-03T09:00:00.000Z' });
    expect(await b.account.push([again])).toEqual({ kind: 'stored' });
    expect(byIdentity((await a.account.pull()).records).get(`watchProgress/${film.key}`)).toEqual(again);

    // A watch record names its own profile in its key: another account's is refused.
    const stray = watched({ userId: robin, identity: 'tmdb:movie:604', round: 0, watched: true, createdAt: 'x', updatedAt: 'x' });
    expect(await a.account.push([stray])).toMatchObject({ kind: 'refused', index: 0 });
  });

  it('keeps the server’s rules: the limit, deleted stays deleted, a password left out kept, all or nothing', async () => {
    const server = await serve({ maxProfiles: 2 });
    const a = await signedUp(server);
    expect(await a.account.info()).toMatchObject({ maxProfiles: 2 });
    expect(await a.account.push([profile(sam, 'Sam'), profile(robin, 'Robin')])).toEqual({ kind: 'stored' });

    expect(await a.account.push([pin(sam, '1234'), profile(kim, 'Kim')])).toEqual({ kind: 'refused', index: 1, reason: 'limit' });
    expect(byIdentity((await a.account.pull()).records).has(`pin/${sam}`)).toBe(false);

    expect(await a.account.push([tombstone('profile', robin)])).toEqual({ kind: 'stored' });
    expect(await a.account.push([profile(robin, 'Robin again')])).toEqual({ kind: 'refused', index: 0, reason: 'deleted' });
    // A deleted profile holds no place: there is room for Kim now.
    expect(await a.account.push([profile(kim, 'Kim')])).toEqual({ kind: 'stored' });

    expect(await a.account.push([connection(home, { password: 'family-secret' })])).toEqual({ kind: 'stored' });
    // Listed without its value — a device that lacks it — the stored one stays.
    expect(await a.account.push([connection(home, { label: 'Renamed' })])).toEqual({ kind: 'stored' });

    const invalid = { kind: 'pin', key: sam, deleted: false, data: { userId: sam, pin: 'not a pin' } } as unknown as AccountRecord;
    expect(await a.account.push([profile(sam, 'Sam, renamed'), invalid])).toEqual({ kind: 'refused', index: 1, reason: 'invalid' });

    const read = byIdentity((await a.account.pull()).records);
    expect(read.get(`connection/${home}`)).toEqual(connection(home, { label: 'Renamed', password: 'family-secret' }));
    expect(read.get(`profile/${robin}`)).toEqual(tombstone('profile', robin));
    expect(read.get(`profile/${sam}`)).toEqual(profile(sam, 'Sam'));
  });

  it('lands a resent batch on the same records, changing nothing', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const batch = [profile(sam, 'Sam'), preference(sam, 'homeLayout', { version: 1, rows: [] }), connection(home, { password: 'family-secret' })];
    expect(await a.account.push(batch)).toEqual({ kind: 'stored' });
    const first = (await a.account.pull()).records;
    expect(await a.account.push(batch)).toEqual({ kind: 'stored' });
    expect((await a.account.pull()).records).toEqual(first);
  });

  it('takes a whole account in one batch, with the rate limits on', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const users = Array.from({ length: 10 }, (_, index) => userId(`user-${index}`));
    const connections = Array.from({ length: 20 }, (_, index) => connectionId(`connection-${index}`));
    const everything = [
      ...users.flatMap((id) => [profile(id, id), pin(id, '1234'), preference(id, 'homeLayout', { version: 1, rows: [] })]),
      ...connections.map((id) => connection(id, { password: 'family-secret' })),
      ...connections.flatMap((id) => users.map((user) => profileValues(id, user, 'own-secret'))),
    ];
    expect(await a.account.push(everything)).toEqual({ kind: 'stored' });
    expect((await a.account.pull()).records).toHaveLength(everything.length);
  });

  it('checks the owner with the password typed again, never the saved one', async () => {
    const server = await serve();
    const a = await signedUp(server);
    await expect(a.account.verifyOwner?.({ password: 'a guess' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(a.account.verifyOwner?.({ password: '' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(a.account.verifyOwner?.({ password: PASSWORD })).resolves.toBeUndefined();
    // An empty proof never reached the server, so it never counted as a wrong try.
    expect(a.http.count(SIGN_IN)).toBe(2);
    // Checking the owner leaves the device's own session as it was.
    expect(await a.account.pull()).toEqual({ records: [] });
    expect(a.http.count(SIGN_IN)).toBe(2);
  });

  it('is refused once when the password changed elsewhere, then parked — until the user signs in again', async () => {
    const server = await serve();
    const a = await signedUp(server);
    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    await b.account.status();
    await server.setPassword(a.accountId, 'a brand new password');

    await expect(b.account.pull()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(b.http.count(SIGN_IN)).toBe(2);
    const asked = b.http.exchanges.length;
    await expect(b.account.pull()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(b.account.push([profile(sam, 'Sam')])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(b.http.exchanges).toHaveLength(asked);

    // Relaunched, it stays parked: the refusal is kept with its session.
    const relaunched = await b.relaunch();
    await expect(relaunched.account.pull()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(relaunched.http.exchanges).toHaveLength(0);

    // Signing in again, with the new password, starts a session of its own.
    const again = await device(server, { name: 'b', username: 'sam', password: 'a brand new password' });
    expect((await again.account.status()).accountId).toBe(a.accountId);
    expect(await again.account.pull()).toEqual({ records: [] });
  });

  it('signs in once more, with the saved password, when its session ended', async () => {
    const server = await serve();
    const a = await signedUp(server);
    // The same password set again: every session goes, and the saved password still works.
    await server.setPassword(a.accountId, PASSWORD);
    expect(await a.account.pull()).toEqual({ records: [] });
    expect(a.http.count(SIGN_IN)).toBe(1);
    expect(await a.account.push([profile(sam, 'Sam')])).toEqual({ kind: 'stored' });
    expect(a.http.count(SIGN_IN)).toBe(1);
  });

  it('forgets its session on signing out, and signs in on the next call', async () => {
    const server = await serve();
    const a = await signedUp(server);
    expect(a.session.value).toBeDefined();
    await a.account.signOut?.();
    expect(a.session.value).toBeUndefined();
    const relaunched = await a.relaunch();
    expect((await relaunched.account.status()).accountId).toBe(a.accountId);
    expect(relaunched.http.count(SIGN_IN)).toBe(1);
  });

  it('makes a first profile, named after the account, for a device that has none', async () => {
    const server = await serve();
    const a = await signedUp(server, { firstProfile: true });
    const { records } = await a.account.pull();
    expect(records).toEqual([{ kind: 'profile', key: expect.any(String), deleted: false, data: { userId: expect.any(String), name: 'sam' } }]);
    // It is a record like any other: a rename lands on it.
    const first = records[0];
    if (first?.kind !== 'profile' || first.deleted) throw new Error('setup');
    expect(await a.account.push([profile(first.data.userId, 'Sam')])).toEqual({ kind: 'stored' });
    expect((await a.account.pull()).records).toEqual([profile(first.data.userId, 'Sam')]);
  });

  it('spends an invite on one account, and takes none on a closed server', async () => {
    const server = await serve();
    const invite = await server.invite();
    const a = await device(server, { name: 'a', username: 'sam', password: PASSWORD });
    await a.account.createAccount?.({ invite }, { firstProfile: false });
    const b = await device(server, { name: 'b', username: 'robin', password: PASSWORD });
    await expect(b.account.createAccount?.({ invite }, { firstProfile: false })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const closed = await serve({ signUp: 'closed' });
    const c = await device(closed, { name: 'c', username: 'sam', password: PASSWORD });
    expect(await c.account.info()).toMatchObject({ signUp: 'closed' });
    await expect(c.account.createAccount?.({ invite: 'ANY' }, { firstProfile: false })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const open = await serve({ signUp: 'open' });
    const d = await device(open, { name: 'd', username: 'sam', password: PASSWORD });
    await expect(d.account.createAccount?.({ invite: '' }, { firstProfile: false })).resolves.toMatchObject({ accountName: expect.any(String) });
  });

  it('waits when the server throttles sign-ins, and refuses nobody for good', async () => {
    const server = await serve();
    const a = await signedUp(server);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(a.account.verifyOwner?.({ password: `guess ${attempt}` })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(a.account.verifyOwner?.({ password: PASSWORD })).rejects.toMatchObject({ code: 'UNAUTHORIZED', reason: 'too-many-attempts' });

    const b = await device(server, { name: 'b', username: 'sam', password: PASSWORD });
    await expect(b.account.status()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retry: 'backoff', reason: 'too-many-attempts' });
    // Throttled is not refused: nothing judged the password, so nothing is latched.
    expect(b.session.value).toBeUndefined();
  });
});
