import { createHash } from 'node:crypto';

// Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 12;

/** A one-time code: 60 random bits, as three groups of four. */
export function newInviteCode(random: (length: number) => Buffer): string {
  let bits = 0n;
  for (const byte of random(8)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let index = 0; index < LENGTH; index += 1) {
    code = (ALPHABET[Number(bits & 31n)] ?? '0') + code;
    bits >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** The hash an invite is stored under, from a code as someone typed it; `undefined` if it cannot be one. */
export function inviteHash(typed: unknown): Buffer | undefined {
  if (typeof typed !== 'string') return undefined;
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== LENGTH || [...code].some((char) => !ALPHABET.includes(char))) return undefined;
  return createHash('sha256').update(code, 'utf8').digest();
}
