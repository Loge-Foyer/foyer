/**
 * Where a device is in an account's log: the epoch the account was in, a
 * position, and the id of the change stored there. A cursor that does not
 * match — another epoch, a position past the end, another change at it — is
 * from a log that is gone, and its device must join again.
 */
export interface Cursor {
  readonly epoch: string;
  readonly seq: number;
  /** Absent only at the very start. */
  readonly changeId?: string;
}

export function encodeCursor(cursor: Cursor): string {
  const body = { v: 1, e: cursor.epoch, s: cursor.seq, ...(cursor.changeId === undefined ? {} : { c: cursor.changeId }) };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** `undefined` for anything this server did not write. */
export function decodeCursor(text: string): Cursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const { v, e, s, c } = value as Readonly<Record<string, unknown>>;
    if (v !== 1 || typeof e !== 'string' || typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return undefined;
    if (s === 0 ? c !== undefined : typeof c !== 'string') return undefined;
    return { epoch: e, seq: s, ...(typeof c === 'string' ? { changeId: c } : {}) };
  } catch {
    return undefined;
  }
}
