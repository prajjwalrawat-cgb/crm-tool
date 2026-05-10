import 'server-only';

import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PAGE_SIZES,
  parsePageSize,
} from './page-size';

/**
 * Cursor encoding for keyset pagination. Each cursor is the `(timestamp,
 * id)` of the last row already returned. The next page's predicate is:
 *
 *     WHERE (created_at, id) < (cursor.ts, cursor.id)
 *
 * `id` is a UUID v4 string; we tie-break on it deterministically so a
 * burst of rows inserted in the same millisecond never duplicates or
 * skips on page boundaries.
 *
 * The cursor is base64url-encoded JSON so it can ride a URL query
 * parameter without further escaping. We don't sign it — a tampered
 * cursor still goes through RLS + tenant filtering, so the worst a
 * caller can do is fetch their own data starting from a different
 * point. Surface area, not security.
 *
 * SERVER-ONLY: the encoder uses Node's `Buffer`. The page-size enum
 * and `parsePageSize` were moved to `./page-size.ts` (no Node deps,
 * no `server-only` marker) so Client Components can import them.
 * Server callers can still import everything from this file because
 * it re-exports the page-size primitives below.
 */

export type Cursor = {
  /** ISO-8601 timestamp of the keyset column. */
  ts: string;
  /** UUID for tie-breaking when timestamps collide. */
  id: string;
};

const CURSOR_RE = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(c: Cursor): string {
  const json = JSON.stringify({ ts: c.ts, id: c.id });
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  if (!CURSOR_RE.test(raw)) return null;
  try {
    const padded =
      raw.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (raw.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const obj = JSON.parse(json) as Partial<Cursor>;
    if (typeof obj.ts !== 'string' || typeof obj.id !== 'string') return null;
    // Reject obviously bad timestamps so a downstream Date() coercion
    // doesn't produce NaN that would silently match nothing.
    if (Number.isNaN(Date.parse(obj.ts))) return null;
    return { ts: obj.ts, id: obj.id };
  } catch {
    return null;
  }
}

export function parseCursorParam(raw: string | string[] | undefined): Cursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return decodeCursor(value);
}

export type Page<T> = {
  items: T[];
  /** Cursor to use for the next request. `null` when no more rows. */
  nextCursor: string | null;
  /** Effective page size (after clamping). */
  size: PageSize;
};

/**
 * Build a `Page<T>` from query results. Strategy: SELECT `size + 1`
 * rows; if we got back more than `size` then there's a next page and
 * we drop the extra row, taking the cursor from the last returned
 * row. This avoids a separate COUNT(*) and a second round-trip.
 *
 * Each row must have `id` and a sortable `created_at`-style field.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  size: PageSize,
  cursorOf: (row: T) => Cursor,
): Page<T> {
  if (rows.length <= size) {
    return { items: rows, nextCursor: null, size };
  }
  const visible = rows.slice(0, size);
  const last = visible[visible.length - 1]!;
  return {
    items: visible,
    nextCursor: encodeCursor(cursorOf(last)),
    size,
  };
}

// Server-side re-exports so callers that previously imported the
// page-size primitives from this file keep working. Client Components
// MUST import from `./page-size` directly.
export { DEFAULT_PAGE_SIZE, type PageSize, PAGE_SIZES, parsePageSize };
