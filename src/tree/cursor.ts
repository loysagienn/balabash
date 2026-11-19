// The cursor of a list paged along the log: the seq the next page starts
// before. Opaque to the caller — it passes `nextCursor` of one result as
// `cursor` of the next call and never writes one itself.

import { CapabilityError } from '../catalog/index.ts';

const MAX_SEQ = 2n ** 63n - 1n;

export function seqCursor(seq: bigint | number): string {
  return String(seq);
}

// The position a cursor names; undefined for the first page.
export function cursorSeq(cursor: string | undefined): bigint | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  // What seqCursor writes: a position of the log — a positive integer of
  // the database's bigint, without leading zeros.
  if (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > MAX_SEQ) {
    throw new CapabilityError(
      'invalid_input',
      'cursor is not a cursor of this list: pass `nextCursor` of the previous result as it is, or leave cursor out for the first page.',
    );
  }

  return BigInt(cursor);
}

// One page out of rows read one over the limit: the extra row only tells
// that there is more, and the last row of the page is where the next one
// starts.
export function page<T>(rows: T[], limit: number, seqOf: (row: T) => bigint | number): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }

  const kept = rows.slice(0, limit);

  return { rows: kept, nextCursor: seqCursor(seqOf(kept[kept.length - 1] as T)) };
}
