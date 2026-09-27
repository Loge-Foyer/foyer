import { createHash } from 'node:crypto';

/** Only a token's hash is stored: a copy of the database signs no one in. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export function newToken(random: (length: number) => Buffer): { readonly token: string; readonly hash: Buffer } {
  const token = random(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
