import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { dealDateChanges } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Close-date change log for one deal, newest first — what the deal detail
 * page's "Date history" section renders. Read-only: the rows are written by
 * the `deal_close_date_pushback_sync` trigger (0058), never by the app.
 */
export type DealDateChangeEntry = {
  id: string;
  oldCloseDate: string | null;
  newCloseDate: string | null;
  changedBy: string | null;
  changedAt: Date;
  reason: string | null;
  /** True when this change counted toward `deals.push_count`. */
  isPush: boolean;
};

/**
 * A deal's close-date timeline. Capped — a date that has moved 200 times is a
 * data problem, not a timeline worth scrolling.
 */
export async function listDealDateChanges(
  tenantId: string,
  dealId: string,
  limit = 200,
): Promise<DealDateChangeEntry[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        id: dealDateChanges.id,
        oldCloseDate: dealDateChanges.oldCloseDate,
        newCloseDate: dealDateChanges.newCloseDate,
        changedBy: dealDateChanges.changedBy,
        changedAt: dealDateChanges.changedAt,
        reason: dealDateChanges.reason,
        isPush: dealDateChanges.isPush,
      })
      .from(dealDateChanges)
      .where(
        and(
          eq(dealDateChanges.tenantId, tenantId),
          eq(dealDateChanges.dealId, dealId),
        ),
      )
      .orderBy(desc(dealDateChanges.changedAt), desc(dealDateChanges.id))
      .limit(limit),
  );
}
