import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app';
import { databaseFile, readConfig } from './config';
import { crashHooks } from './hooks';
import { takeLock } from './lock';
import { consoleLogger } from './logger';
import { openDatabase } from './store/db';

const config = readConfig();
mkdirSync(config.dataDir, { recursive: true });
const release = takeLock(config.dataDir);
const db = openDatabase(databaseFile(config.dataDir));

// Behind a reverse proxy, the client is the hop the proxy appended — the last one. Anything before it the client wrote itself.
const clientAddress = (c: Context): string => {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || (getConnInfo(c).remote.address ?? 'unknown');
};

const faults = crashHooks(process.env);
const app = createApp({ db, now: Date.now, random: randomBytes, clientAddress, logger: consoleLogger, ...(faults ? { faults } : {}) });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  consoleLogger.info(`Streaming Center sync server listening on ${config.host}:${info.port}, data in ${config.dataDir}`);
});

const stop = () => {
  server.close(() => {
    db.close();
    release();
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
