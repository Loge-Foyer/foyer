import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const lockPath = (dataDir: string) => join(dataDir, 'server.lock');

/** Marks the data directory as in use by this process, on this host. The returned function lets it go. */
export function takeLock(dataDir: string): () => void {
  writeFileSync(lockPath(dataDir), JSON.stringify({ pid: process.pid, host: hostname() }));
  return () => rmSync(lockPath(dataDir), { force: true });
}

/** A server using the data directory: a process here, or one on another host that cannot be asked. */
export type LockHolder = { readonly kind: 'running'; readonly pid: number } | { readonly kind: 'elsewhere'; readonly host: string };

/**
 * The server using this data directory, if any. A process on this host is
 * asked whether it lives, so a lock left by a crash names nobody. One on
 * another host — another container on the same volume, whose process ids
 * mean nothing here — cannot be asked: its lock holds until it lets go, or
 * someone who knows it stopped removes the file.
 */
export function lockHolder(dataDir: string): LockHolder | undefined {
  let text: string;
  try {
    text = readFileSync(lockPath(dataDir), 'utf8');
  } catch {
    return undefined;
  }
  const { pid, host } = parseLock(text);
  if (host !== undefined && host !== hostname()) return { kind: 'elsewhere', host };
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0);
    return { kind: 'running', pid };
  } catch {
    return undefined;
  }
}

function parseLock(text: string): { readonly pid?: number; readonly host?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  // A bare number: a lock from before hosts were recorded, taken on this one.
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? { pid: value } : {};
  if (typeof value !== 'object' || value === null) return {};
  const { pid, host } = value as Readonly<Record<string, unknown>>;
  return {
    ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof host === 'string' ? { host } : {}),
  };
}
