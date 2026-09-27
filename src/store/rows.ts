/** What node:sqlite hands back for a row; each read checks its column is what the schema says. */
export type Row = Readonly<Record<string, unknown>>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Column ${column} is not text.`);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Column ${column} is not an integer.`);
  return value;
}

export function blob(row: Row, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw new Error(`Column ${column} is not a blob.`);
  return value;
}
