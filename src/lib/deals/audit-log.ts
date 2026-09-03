import 'server-only';

import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import { dealAuditLog } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * The unified deal audit trail, read side. Rows are written by the
 * `deal_governance_sync` trigger (0060) and never by the app, so this module
 * is read-only by construction.
 */
export type DealAuditEntry = {
  id: string;
  changedBy: string | null;
  changedAt: Date;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: string;
  reasonCode: string | null;
  reasonNote: string | null;
};

export type DealAuditPage = {
  entries: DealAuditEntry[];
  /**
   * Opaque cursor for the next page, or null at the end. Keyset, not OFFSET:
   * the log grows while it is being paged, and OFFSET would skip or repeat
   * rows as new entries land at the top.
   */
  nextCursor: string | null;
};

export const AUDIT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** `<iso timestamp>|<uuid>` — the (changedAt, id) pair the ordering is on. */
function encodeCursor(entry: DealAuditEntry): string {
  return `${entry.changedAt.toISOString()}|${entry.id}`;
}

function decodeCursor(raw: string): { changedAt: Date; id: string } | null {
  const idx = raw.lastIndexOf('|');
  if (idx <= 0) return null;
  const changedAt = new Date(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (Number.isNaN(changedAt.getTime()) || !id) return null;
  return { changedAt, id };
}

/**
 * One page of a deal's audit trail, most recent first — what the detail
 * page's Audit tab renders.
 *
 * Ordered by (changedAt DESC, id DESC) and paged on that same pair. A single
 * UPDATE writes up to three rows sharing one `now()`, so `changedAt` alone is
 * not unique and paging on it would drop rows at a page boundary.
 */
export async function listDealAuditLog(
  tenantId: string,
  dealId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<DealAuditPage> {
  const limit = Math.min(Math.max(opts.limit ?? AUDIT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: dealAuditLog.id,
        changedBy: dealAuditLog.changedBy,
        changedAt: dealAuditLog.changedAt,
        fieldName: dealAuditLog.fieldName,
        oldValue: dealAuditLog.oldValue,
        newValue: dealAuditLog.newValue,
        changeType: dealAuditLog.changeType,
        reasonCode: dealAuditLog.reasonCode,
        reasonNote: dealAuditLog.reasonNote,
      })
      .from(dealAuditLog)
      .where(
        and(
          eq(dealAuditLog.tenantId, tenantId),
          eq(dealAuditLog.dealId, dealId),
          ...(after
            ? [
                or(
                  lt(dealAuditLog.changedAt, after.changedAt),
                  and(
                    eq(dealAuditLog.changedAt, after.changedAt),
                    lt(dealAuditLog.id, after.id),
                  ),
                )!,
              ]
            : []),
        ),
      )
      .orderBy(desc(dealAuditLog.changedAt), desc(dealAuditLog.id))
      // One extra row is the "is there a next page?" probe — cheaper and
      // race-free compared with a second COUNT query.
      .limit(limit + 1),
  );

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  return {
    entries,
    nextCursor: hasMore ? encodeCursor(entries[entries.length - 1]!) : null,
  };
}

/**
 * Per-deal counts by change type, for the Audit tab's header. One grouped scan
 * of the same index the listing uses.
 */
export async function dealAuditSummary(
  tenantId: string,
  dealId: string,
): Promise<Record<string, number>> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        changeType: dealAuditLog.changeType,
        n: sql<string>`count(*)`,
      })
      .from(dealAuditLog)
      .where(
        and(
          eq(dealAuditLog.tenantId, tenantId),
          eq(dealAuditLog.dealId, dealId),
        ),
      )
      .groupBy(dealAuditLog.changeType),
  );
  return Object.fromEntries(rows.map((r) => [r.changeType, Number(r.n) || 0]));
}
