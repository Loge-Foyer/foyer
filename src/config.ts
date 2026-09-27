import { join, resolve } from 'node:path';

/** How the server runs, read from its environment. */
export interface Config {
  readonly port: number;
  readonly host: string;
  /** Where the database and the lock file live. */
  readonly dataDir: string;
  /** Behind a reverse proxy: a client's address is the hop the proxy appended to `X-Forwarded-For`. */
  readonly trustProxy: boolean;
}

export function readConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const port = Number(env.SC_SYNC_PORT ?? '8730');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`SC_SYNC_PORT is not a port number: ${env.SC_SYNC_PORT}`);
  return {
    port,
    host: env.SC_SYNC_HOST ?? '0.0.0.0',
    dataDir: resolve(env.SC_SYNC_DATA ?? 'data'),
    trustProxy: env.SC_SYNC_TRUST_PROXY === '1' || env.SC_SYNC_TRUST_PROXY === 'true',
  };
}

export const databaseFile = (dataDir: string) => join(dataDir, 'sync.db');
