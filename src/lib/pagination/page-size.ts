/**
 * Pure pagination primitives — safe to import from Client Components.
 *
 * This file deliberately has NO `import 'server-only'` and NO Node-only
 * dependencies (Buffer, AsyncLocalStorage, etc). Anything that touches
 * the request/response cycle, the database, or Node-only APIs lives in
 * `cursor.ts` (server-only) instead.
 *
 * Architectural rule: a Client Component may import from here. It must
 * never import from `cursor.ts` (which is marked `server-only` because
 * its base64url encoding uses `Buffer`).
 */

/**
 * The page-size enum the UI selector exposes. Anything outside the set
 * collapses to the default. Keeping this small caps the upper bound of
 * a single fetch to 100 rows even if a caller tries `?size=10000`.
 */
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 50;

export function parsePageSize(raw: string | string[] | undefined): PageSize {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(n)
    ? (n as PageSize)
    : DEFAULT_PAGE_SIZE;
}
