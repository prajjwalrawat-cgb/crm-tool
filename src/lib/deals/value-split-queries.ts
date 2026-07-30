import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';

import { dealValueSplits } from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';

import type { SplitRow } from './value-split';

/** The stored breakdown for one deal, ordered by element then contract year. */
export async function listDealValueSplit(
  tenantId: string,
  dealId: string,
): Promise<SplitRow[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select({
        elementIndex: dealValueSplits.elementIndex,
        component: dealValueSplits.component,
        componentLabel: dealValueSplits.componentLabel,
        billingType: dealValueSplits.billingType,
        yearIndex: dealValueSplits.yearIndex,
        periodStart: dealValueSplits.periodStart,
        periodEnd: dealValueSplits.periodEnd,
        amountMinor: dealValueSplits.amountMinor,
      })
      .from(dealValueSplits)
      .where(
        and(
          eq(dealValueSplits.tenantId, tenantId),
          eq(dealValueSplits.dealId, dealId),
        ),
      )
      .orderBy(asc(dealValueSplits.elementIndex), asc(dealValueSplits.yearIndex)),
  );
  return rows;
}

/**
 * Splits for many deals at once, keyed by deal id — used by the export so a
 * sheet of N deals costs one query rather than N.
 */
export async function listDealValueSplitsFor(
  exec: DbExecutor,
  tenantId: string,
  dealIds: string[],
): Promise<Map<string, SplitRow[]>> {
  const out = new Map<string, SplitRow[]>();
  if (dealIds.length === 0) return out;

  const rows = await exec
    .select({
      dealId: dealValueSplits.dealId,
      elementIndex: dealValueSplits.elementIndex,
      component: dealValueSplits.component,
      componentLabel: dealValueSplits.componentLabel,
      billingType: dealValueSplits.billingType,
      yearIndex: dealValueSplits.yearIndex,
      periodStart: dealValueSplits.periodStart,
      periodEnd: dealValueSplits.periodEnd,
      amountMinor: dealValueSplits.amountMinor,
    })
    .from(dealValueSplits)
    .where(
      and(
        eq(dealValueSplits.tenantId, tenantId),
        inArray(dealValueSplits.dealId, dealIds),
      ),
    )
    .orderBy(asc(dealValueSplits.elementIndex), asc(dealValueSplits.yearIndex));

  for (const r of rows) {
    const list = out.get(r.dealId) ?? [];
    list.push({
      elementIndex: r.elementIndex,
      component: r.component,
      componentLabel: r.componentLabel,
      billingType: r.billingType,
      yearIndex: r.yearIndex,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      amountMinor: r.amountMinor,
    });
    out.set(r.dealId, list);
  }
  return out;
}

/**
 * Replace a deal's split wholesale. The UI always submits the complete set, so
 * a delete-then-insert inside the caller's transaction is both simpler and
 * safer than diffing rows — there's no partial state to reconcile.
 */
export async function replaceDealValueSplit(
  tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0],
  params: { tenantId: string; dealId: string; rows: SplitRow[] },
): Promise<void> {
  await tx
    .delete(dealValueSplits)
    .where(
      and(
        eq(dealValueSplits.tenantId, params.tenantId),
        eq(dealValueSplits.dealId, params.dealId),
      ),
    );

  if (params.rows.length === 0) return;

  await tx.insert(dealValueSplits).values(
    params.rows.map((r) => ({
      tenantId: params.tenantId,
      dealId: params.dealId,
      elementIndex: r.elementIndex,
      component: r.component,
      componentLabel: r.componentLabel ?? null,
      billingType: r.billingType,
      yearIndex: r.yearIndex,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      amountMinor: r.amountMinor,
    })),
  );
}
