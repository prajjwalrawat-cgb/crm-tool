import 'server-only';

import { incr, observe } from '@/lib/observability';

/**
 * Timing wrapper used by the paginated list queries. Records:
 *
 *   - histogram `page.query_ms{page=<page>}` — duration in ms
 *   - histogram `page.query_rows{page=<page>}` — row count returned
 *   - counter   `page.query_count{page=<page>}` — total invocations
 *
 * Both surfaces show up automatically on /dashboard/ops latency
 * section because that section already aggregates any histogram whose
 * key ends in `_ms` or `duration_ms`.
 */
export async function timeQuery<T>(
  page: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - startedAt;
    observe('page.query_ms', ms, { page });
    // Best-effort row-count emission. Handles both `Page<T>` (items[])
    // and bare arrays.
    const maybe = result as unknown as { items?: unknown[]; length?: number };
    if (Array.isArray(maybe?.items)) {
      observe('page.query_rows', maybe.items.length, { page });
    } else if (typeof maybe?.length === 'number') {
      observe('page.query_rows', maybe.length, { page });
    }
    incr('page.query_count', 1, { page, status: 'ok' });
    return result;
  } catch (err) {
    incr('page.query_count', 1, { page, status: 'error' });
    observe('page.query_ms', Date.now() - startedAt, { page });
    throw err;
  }
}
