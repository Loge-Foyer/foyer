import { isKdfParams } from '@sc/api';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';

import { inviteHash } from './auth/invites';
import { parametersForUnknown, proofMatches, verifierOf } from './auth/proof';
import { ADDRESS_POLICY, createThrottle, SUBJECT_POLICY } from './auth/throttle';
import { hashToken, newToken } from './auth/tokens';
import type { Logger } from './logger';
import { accountById, accountByName, insertAccount, type Account, type StoredKdf } from './store/accounts';
import { pullChanges, pushChanges, type Faults } from './store/changes';
import { transaction, type Database } from './store/db';
import { deleteDevice, deviceByTokenHash, devicesOf, signInDevice, touchDevice, type Device } from './store/devices';
import { spendInvite } from './store/invites';
import { serverSecret } from './store/settings';

export const VERSION = '0.1.0';

export interface AppDeps {
  readonly db: Database;
  readonly now: () => number;
  readonly random: (length: number) => Buffer;
  /** Who is asking, for the throttle: the socket's address, or the reverse proxy's word for it. */
  readonly clientAddress: (c: Context) => string;
  readonly logger: Logger;
  readonly faults?: Faults;
}

type Env = { Variables: { device: Device; account: Account } };

const BODY_LIMIT = 8 * 1024 * 1024;
const MAX_PUSH = 1_000;
const PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_COUNT = 200;
const MAX_PAGE_COUNT = 500;
const PROOF_BYTES = 32;
const MAX_VAULT = 1_024;
const USERNAME = /^[a-z0-9._-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Creating an account refused inside its transaction, so nothing — the invite included — is spent. */
class Refused extends Error {
  constructor(readonly status: 403 | 409, readonly code: string) {
    super(code);
  }
}

/**
 * The server: accounts, their devices, and one log each. It stores and
 * returns; it never decides between two changes.
 */
export function createApp(deps: AppDeps): Hono<Env> {
  const { db, now, random, logger } = deps;
  const secret = serverSecret(db, random);
  const throttle = createThrottle(now, (bucket) => (bucket.startsWith('address|') ? ADDRESS_POLICY : SUBJECT_POLICY));
  const app = new Hono<Env>();

  // Bearer tokens, never cookies: any page may call, and none can borrow a session.
  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], maxAge: 600 }));
  app.use('*', bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'too-large' }, 413) }));
  app.use('*', async (c, next) => {
    const started = now();
    await next();
    // The route's pattern, never its path: a cursor or a device id is nobody's business in a log.
    logger.info(`${c.req.method} ${c.req.routePath} ${c.res.status} ${now() - started}ms`);
  });
  app.notFound((c) => c.json({ error: 'not-found' }, 404));
  app.onError((error, c) => {
    logger.error(`${c.req.method} ${c.req.routePath} failed: ${error.name}`);
    return c.json({ error: 'server' }, 500);
  });

  const bearer = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const device = token === '' ? undefined : deviceByTokenHash(db, hashToken(token));
    const account = device ? accountById(db, device.accountId) : undefined;
    if (!device || !account) return c.json({ error: 'unauthorized' }, 401);
    touchDevice(db, device, now());
    c.set('device', device);
    c.set('account', account);
    await next();
  });

  const throttled = (c: Context, waitMs: number) => {
    c.header('Retry-After', String(Math.ceil(waitMs / 1_000)));
    return c.json({ error: 'too-many-attempts' }, 429);
  };

  const signedIn = (account: Account, installation: string, deviceName: string) => {
    const { token, hash } = newToken(random);
    const device = signInDevice(db, {
      id: random(16).toString('base64url'),
      accountId: account.id,
      installation,
      name: deviceName === '' ? 'A device' : deviceName,
      tokenHash: hash,
      now: now(),
    });
    return { token, device: { id: device.id }, account: { name: account.username }, vault: account.vault };
  };

  app.get('/v1/health', (c) => c.json({ ok: true, version: VERSION }));

  app.post('/v1/auth/params', async (c) => {
    const username = usernameOf((await body(c))?.username);
    if (!username) return c.json({ error: 'invalid' }, 400);
    // One read either way, and parameters either way: asking does not tell whether the account exists.
    const account = accountByName(db, username);
    return c.json({ kdf: account?.kdf ?? parametersForUnknown(secret, username) });
  });

  app.post('/v1/auth/login', async (c) => {
    const input = await body(c);
    const username = usernameOf(input?.username);
    const proof = bytesOf(input?.proof, PROOF_BYTES);
    const installation = textOf(input?.installation, 128);
    const deviceName = textOf(input?.deviceName, 200);
    if (!username || !proof || !installation || deviceName === undefined) return c.json({ error: 'invalid' }, 400);
    const address = deps.clientAddress(c);
    // Per name and address, and per address: nobody can lock an account from somewhere else.
    const buckets = [`login|${username}|${address}`, `address|${address}`];
    const wait = throttle.waitFor(buckets);
    if (wait > 0) return throttled(c, wait);
    const account = accountByName(db, username);
    if (!account || !proofMatches(proof, account.verifier)) {
      throttle.miss(buckets);
      return c.json({ error: 'unauthorized' }, 401);
    }
    throttle.clear(buckets.slice(0, 1));
    return c.json(signedIn(account, installation, deviceName));
  });

  app.post('/v1/accounts', async (c) => {
    const input = await body(c);
    const address = deps.clientAddress(c);
    const buckets = [`invite|${address}`, `address|${address}`];
    const wait = throttle.waitFor(buckets);
    if (wait > 0) return throttled(c, wait);
    // The invite first: only someone holding one learns whether a name is taken.
    const invite = inviteHash(input?.invite);
    if (!invite) {
      throttle.miss(buckets);
      return c.json({ error: 'invite' }, 403);
    }
    const username = usernameOf(input?.username);
    const kdf = kdfOf(input?.kdf);
    const proof = bytesOf(input?.proof, PROOF_BYTES);
    const vault = typeof input?.vault === 'string' && input.vault.length <= MAX_VAULT && BASE64URL.test(input.vault) ? input.vault : undefined;
    const installation = textOf(input?.installation, 128);
    const deviceName = textOf(input?.deviceName, 200);
    if (!username || !kdf || !proof || !vault || !installation || deviceName === undefined) return c.json({ error: 'invalid' }, 400);
    try {
      const account = transaction(db, () => {
        if (!spendInvite(db, invite, now())) throw new Refused(403, 'invite');
        if (accountByName(db, username)) throw new Refused(409, 'taken');
        return insertAccount(db, { username, kdf, verifier: verifierOf(proof), vault, epoch: random(12).toString('base64url'), createdAt: now() });
      });
      throttle.clear(buckets.slice(0, 1));
      return c.json(signedIn(account, installation, deviceName));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (error.status === 403) throttle.miss(buckets);
      return c.json({ error: error.code }, error.status);
    }
  });

  app.post('/v1/auth/verify', bearer, async (c) => {
    const proof = bytesOf((await body(c))?.proof, PROOF_BYTES);
    if (!proof) return c.json({ error: 'invalid' }, 400);
    // Per device: a signed-in device can guess no faster than anyone else.
    const buckets = [`verify|${c.get('device').id}`];
    const wait = throttle.waitFor(buckets);
    if (wait > 0) return throttled(c, wait);
    if (!proofMatches(proof, c.get('account').verifier)) {
      throttle.miss(buckets);
      return c.json({ error: 'wrong-proof' }, 403);
    }
    throttle.clear(buckets);
    return c.body(null, 204);
  });

  app.post('/v1/auth/logout', bearer, (c) => {
    deleteDevice(db, c.get('device').id);
    return c.body(null, 204);
  });

  app.get('/v1/status', bearer, (c) => {
    const device = c.get('device');
    return c.json({ account: { name: c.get('account').username }, device: { id: device.id, name: device.name } });
  });

  app.get('/v1/sync/pull', bearer, (c) => {
    const cursor = c.req.query('cursor');
    const asked = Number(c.req.query('limit') ?? PAGE_COUNT);
    const count = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_PAGE_COUNT) : PAGE_COUNT;
    const pulled = pullChanges(db, c.get('account'), cursor === undefined || cursor === '' ? undefined : cursor, { count, bytes: PAGE_BYTES });
    if (pulled.kind === 'reset') return c.json({ kind: 'reset' });
    // Spliced, never re-serialized: each change goes back exactly as it was stored.
    const page = `{"kind":"changes","changes":[${pulled.bodies.join(',')}],"cursor":${JSON.stringify(pulled.cursor)},"more":${pulled.more}}`;
    return c.body(page, 200, { 'content-type': 'application/json' });
  });

  app.post('/v1/sync/push', bearer, async (c) => {
    const changes = (await body(c))?.changes;
    if (!Array.isArray(changes) || changes.length > MAX_PUSH) return c.json({ error: 'invalid' }, 400);
    try {
      return c.json({ accepted: pushChanges(db, c.get('account').id, changes, now(), deps.faults) });
    } catch (error) {
      // Rolled back: nothing was accepted, and the device sends it all again.
      logger.error(`A push was not stored: ${error instanceof Error ? error.message : 'unknown'}`);
      return c.json({ error: 'storage' }, 503);
    }
  });

  app.get('/v1/devices', bearer, (c) => {
    const current = c.get('device').id;
    const devices = devicesOf(db, c.get('account').id).map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      current: device.id === current,
    }));
    return c.json({ devices });
  });

  app.delete('/v1/devices/:id', bearer, (c) =>
    deleteDevice(db, c.req.param('id'), c.get('account').id) ? c.body(null, 204) : c.json({ error: 'not-found' }, 404),
  );

  return app;
}

async function body(c: Context): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
  } catch {
    return undefined;
  }
}

/** Usernames are compared as NFC and in lower case, so two ways of typing one are one account. */
function usernameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const username = value.normalize('NFC').toLowerCase();
  return USERNAME.test(username) ? username : undefined;
}

function textOf(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** Base64url written the one way it can be, and of the length asked for. */
function bytesOf(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return undefined;
  return length === undefined || bytes.length === length ? bytes : undefined;
}

/** A key's parameters as a device sends them, held to the same limits the device holds them to. */
function kdfOf(value: unknown): StoredKdf | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { algorithm, iterations, salt } = value as Readonly<Record<string, unknown>>;
  const bytes = bytesOf(salt);
  if (!bytes || !isKdfParams({ algorithm, iterations, salt: new Uint8Array(bytes) })) return undefined;
  return { algorithm: 'pbkdf2-sha256', iterations: iterations as number, salt: bytes.toString('base64url') };
}
