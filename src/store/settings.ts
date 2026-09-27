import type { Database } from './db';

/**
 * A secret of this server's own, made once: it derives the parameters shown
 * for a username that does not exist, so they look like a real account's.
 */
export function serverSecret(db: Database, random: (length: number) => Buffer): Buffer {
  const read = () => db.prepare("SELECT value FROM settings WHERE key = 'secret'").get()?.value;
  const existing = read();
  if (typeof existing === 'string') return Buffer.from(existing, 'base64url');
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret', ?)").run(random(32).toString('base64url'));
  // Another process opening the same database may have written it first.
  return Buffer.from(String(read()), 'base64url');
}
