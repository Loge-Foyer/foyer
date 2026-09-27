import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lockPath = (dataDir: string) => join(dataDir, 'server.lock');

/** Marks the data directory as in use by this process. The returned function lets it go. */
export function takeLock(dataDir: string): () => void {
  writeFileSync(lockPath(dataDir), String(process.pid));
  return () => rmSync(lockPath(dataDir), { force: true });
}

/** The server process using this data directory, if one is running. A lock left by a crash names no live process. */
export function lockHolder(dataDir: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath(dataDir), 'utf8'));
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}
