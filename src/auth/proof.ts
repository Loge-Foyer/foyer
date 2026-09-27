import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { KDF_LIMITS } from '@sc/api';

import type { StoredKdf } from '../store/accounts';

/** What the app derives new accounts with, and so what an unknown name is shown too. */
export const DEFAULT_ITERATIONS = KDF_LIMITS.minIterations;

/**
 * The proof is a 256-bit key derived on the device, so SHA-256 of it is
 * enough to store: guessing the password behind it costs a full derivation
 * whatever this does, since the wrapped vault key tests a guess as well.
 */
export const verifierOf = (proof: Uint8Array): Buffer => createHash('sha256').update(proof).digest();

export function proofMatches(proof: Uint8Array, verifier: Uint8Array): boolean {
  const actual = verifierOf(proof);
  return actual.length === verifier.length && timingSafeEqual(actual, verifier);
}

/** Parameters for a name no account has: the same shape, and the same every time, so asking does not tell. */
export function parametersForUnknown(secret: Buffer, username: string): StoredKdf {
  const salt = createHmac('sha256', secret).update(`salt|${username}`, 'utf8').digest().subarray(0, 16);
  return { algorithm: 'pbkdf2-sha256', iterations: DEFAULT_ITERATIONS, salt: salt.toString('base64url') };
}
