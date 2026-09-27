// A device, as far as a plugin can tell: the app's host context rebuilt on
// Node — its crypto on node:crypto, the same algorithms the app runs — with
// the server reached in-process instead of over a socket.
import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';

import { isKdfParams, TransportError, type HttpClient, type HttpRequest, type PluginContext, type PluginCrypto } from '@sc/api';

const NONCE = 12;
const TAG = 16;

export function nodeHostCrypto(): PluginCrypto {
  return {
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    deriveKey: async (password, params) => {
      // As the app does: nothing weaker than the floor is derived, whatever a plugin asks.
      if (!isKdfParams(params)) throw new Error('The host refuses weak parameters.');
      return new Uint8Array(pbkdf2Sync(Buffer.from(password.normalize('NFC'), 'utf8'), params.salt, params.iterations, 32, 'sha256'));
    },
    expandKey: async (key, info, length) => new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), Buffer.from(info, 'utf8'), length)),
    seal: async (key, plaintext, context) => {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]));
    },
    open: async (key, sealed, context) => {
      if (sealed.length < NONCE + TAG) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
        return new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]));
      } catch {
        return undefined;
      }
    },
  };
}

export interface Exchange {
  readonly request: HttpRequest;
  readonly status: number;
  readonly text: string;
}

/** The app's HTTP port, answered by the server's own handlers, every exchange recorded. */
export function inProcessHttp(app: { request(input: string, init: RequestInit): Response | Promise<Response> }) {
  const exchanges: Exchange[] = [];
  const client: HttpClient = {
    request: async (request) => {
      if (request.signal?.aborted) throw new TransportError('aborted');
      const response = await app.request(request.url, {
        method: request.method,
        ...(request.headers ? { headers: { ...request.headers } } : {}),
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const text = await response.text();
      exchanges.push({ request, status: response.status, text });
      return { status: response.status, headers, text };
    },
  };
  return {
    client,
    exchanges,
    /** Exchanges with one route, `"POST /v1/auth/login"`. */
    to: (route: string) => exchanges.filter((exchange) => `${exchange.request.method} ${new URL(exchange.request.url).pathname}` === route),
  };
}

/** One device's context: its password, its installation, and a session store that outlives a provider — a relaunch. */
export function hostContext(options: { readonly http: HttpClient; readonly password: string; readonly installationId: string; readonly session?: string }) {
  let session = options.session;
  const context: PluginContext = {
    http: options.http,
    credentials: { read: async () => ({ password: options.password }) },
    session: {
      read: async () => session,
      write: async (value) => {
        session = value;
      },
      clear: async () => {
        session = undefined;
      },
    },
    network: { current: () => 'wifi' },
    client: { appName: 'Streaming Center', appVersion: '1.0.0', deviceName: options.installationId, installationId: options.installationId },
    clock: { now: () => Date.now(), sleep: async () => undefined },
    crypto: nodeHostCrypto(),
  };
  return { context, session: () => session };
}
