import 'server-only';

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { dealOfferings, deals, offerings } from '@/db/schema';
import { formatTenantCurrency } from '@/lib/currency/format';
import { tenantTransaction } from '@/lib/db-context';
import {
  type DealStage,
  DEAL_STAGE_LABELS,
  DEAL_STAGES,
} from '@/lib/deals/schema';
import {
  type OfferingCategory,
  UNCATEGORIZED_LABEL,
} from '@/lib/offerings/types';
import { getOrgSettings } from '@/lib/org-settings/queries';

import {
  type FunnelScope,
  funnelScopeToParams,
  parseFunnelScope,
} from '../funnel-scope';
import type { OwnerScope, ReportFilter, ReportRunner } from '../types';

// Re-exported so a caller that already imports the runner doesn't need a
// second import for the scope it must pass. The definitions live in
// `../funnel-scope` because they are pure URL parsing that the client-side
// scope bar and the selftests need WITHOUT dragging this `server-only`
// module (and through it, the Postgres client) along with them.
export { type FunnelScope, funnelScopeToParams, parseFunnelScope };

/**
 * Funnel by offering — count and value per stage for one offering, one
 * category, or the whole book, plus the per-offering rollup that says where
 * the pipeline actually sits.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTING RULE, STATED ONCE
 *
 * A deal counts toward EVERY offering it is tagged with, not just its
 * primary. A deal bundling SafeOps360 with Implementation Services appears in
 * full — its whole amount — in both funnels.
 *
 * The consequence is arithmetic and intentional: SUM(rollup rows) is GREATER
 * than total pipeline whenever bundles exist. It is not a double-count bug,
 * and the fix is not to divide the amount between tags. "What is the
 * SafeOps360 funnel" means "every deal SafeOps360 is part of, at its real
 * value" — a deal worth ₹40L that includes SafeOps360 is a ₹40L SafeOps360
 * opportunity, not a ₹20L one, because losing it loses the whole thing.
 *
 * The report says so on screen rather than leaving the reader to discover it
 * from numbers that don't add up: `extras.overlapDealCount` is how many deals
 * carry more than one tag, and the section renders a note whenever it is
 * non-zero.
 *
 * Anything that genuinely needs a PARTITION of the pipeline — a split where
 * every deal is counted exactly once — must use `is_primary` instead. The
 * deals list's Offering column does exactly that. This report does not.
 *
 * ---------------------------------------------------------------------------
 * COVERAGE IS PART OF THE REPORT, NOT A FOOTNOTE
 *
 * Every deal that predates the offerings feature is untagged and there is no
 * backfill, so on day one the per-offering numbers cover a fraction of the
 * pipeline. A report that silently showed only the tagged part would be
 * confidently wrong — the honest version puts the Uncategorized total on the
 * same screen, at the same weight, so "SafeOps360 is ₹2Cr" is always read
 * next to "and ₹9Cr isn't attributed to anything yet".
 *
 * ---------------------------------------------------------------------------
 * WINDOW: like `pipeline-by-stage`, this is a live snapshot of current state,
 * not a time-window aggregate, so the date range is not applied. Won and Lost
 * are included as stages because a funnel that stops at Negotiation cannot
 * show a conversion rate.
 */

export type FunnelByOfferingFilter = ReportFilter & {
  scope?: FunnelScope;
};

export type FunnelByOfferingRow = {
  stage: DealStage;
  stageLabel: string;
  count: number;
  totalAmountMinor: number;
};

export type OfferingRollupRow = {
  offeringId: string;
  offeringName: string;
  category: OfferingCategory;
  /** False for a retired offering. It still has deals and still has a funnel. */
  active: boolean;
  dealCount: number;
  totalAmountMinor: number;
  /** Excludes Won and Lost — the part still in play. */
  openDealCount: number;
  openAmountMinor: number;
};

export type FunnelByOfferingExtras = {
  scope: FunnelScope;
  /** Label for whatever the scope resolved to, e.g. "SafeOps360" or "All offerings". */
  scopeLabel: string;
  /**
   * Per-offering totals, value-descending. Always computed over the CATEGORY
   * scope (or everything), never narrowed to a single selected offering — the
   * point of the rollup is to show the selected one in context.
   */
  rollup: OfferingRollupRow[];
  /** Deals carrying no tag at all. The coverage gap, shown, not hidden. */
  uncategorized: { dealCount: number; totalAmountMinor: number };
  /** Every non-deleted deal in scope of the owner filter — the denominator. */
  allDeals: { dealCount: number; totalAmountMinor: number };
  /**
   * Deals carrying MORE than one tag. Non-zero means the rollup's rows
   * deliberately sum to more than `allDeals`; the UI says so when it is.
   */
  overlapDealCount: number;
};

export const funnelByOfferingRunner: ReportRunner<
  FunnelByOfferingFilter,
  FunnelByOfferingRow,
  FunnelByOfferingExtras
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();
  const scope: FunnelScope = filters.scope ?? { type: 'all' };

  const base = (): SQL[] => {
    const conditions: SQL[] = [
      eq(deals.tenantId, tenantId),
      isNull(deals.deletedAt),
    ];
    const owner = buildOwnerCondition(filters.owner, context.currentUserId);
    if (owner) conditions.push(owner);
    return conditions;
  };

  const {
    stageRows,
    rollupRows,
    uncategorized,
    allDeals,
    overlapDealCount,
    scopeLabel,
  } = await tenantTransaction(async (tx) => {
    /* ---- the funnel itself ---- */
    const stageConditions = base();
    const scopeClause = scopeCondition(scope);
    if (scopeClause) stageConditions.push(scopeClause);

    const stageRows = await tx
      .select({
        stage: deals.stage,
        count: sql<number>`count(*)::int`,
        totalAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
      })
      .from(deals)
      .where(and(...stageConditions))
      .groupBy(deals.stage);

    /* ---- the rollup ----
     * Driven FROM deal_offerings so an offering with no deals is absent
     * rather than a row of zeroes: the rollup answers "where is the
     * pipeline", and a catalog entry nobody sells is noise in that list. The
     * Settings page is where the full catalog lives, zero-deal rows included.
     *
     * Narrowed by CATEGORY when a category is selected, but never by a single
     * offering — see the note on `extras.rollup`.
     */
    const rollupConditions = base();
    rollupConditions.push(eq(dealOfferings.tenantId, deals.tenantId));
    if (scope.type === 'category') {
      rollupConditions.push(eq(offerings.category, scope.category));
    }
    const rollupRows = await tx
      .select({
        offeringId: offerings.id,
        offeringName: offerings.name,
        category: offerings.category,
        active: offerings.active,
        dealCount: sql<number>`count(*)::int`,
        totalAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
        openDealCount: sql<number>`count(*) FILTER (WHERE ${deals.stage} NOT IN ('won','lost'))::int`,
        openAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}) FILTER (WHERE ${deals.stage} NOT IN ('won','lost')), 0)::bigint`,
      })
      .from(dealOfferings)
      .innerJoin(offerings, eq(offerings.id, dealOfferings.offeringId))
      .innerJoin(deals, eq(deals.id, dealOfferings.dealId))
      .where(and(...rollupConditions))
      .groupBy(offerings.id, offerings.name, offerings.category, offerings.active)
      .orderBy(desc(sql`coalesce(sum(${deals.amountMinor}), 0)`));

    /* ---- coverage: the untagged remainder, and the whole book ---- */
    const [uncategorizedRow] = await tx
      .select({
        dealCount: sql<number>`count(*)::int`,
        totalAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
      })
      .from(deals)
      .where(and(...base(), uncategorizedCondition()));

    const [allRow] = await tx
      .select({
        dealCount: sql<number>`count(*)::int`,
        totalAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
      })
      .from(deals)
      .where(and(...base()));

    // Bundles. Counted from the deal side so a deal with three tags counts
    // once, which is what "how many deals appear in more than one funnel"
    // means.
    const [overlapRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(deals)
      .where(
        and(
          ...base(),
          sql`(
            SELECT count(*) FROM ${dealOfferings} dof
            WHERE dof.tenant_id = ${deals.tenantId} AND dof.deal_id = ${deals.id}
          ) > 1`,
        ),
      );

    // Resolve the scope's display name inside the same transaction, so a
    // selected offering that has been renamed reads correctly rather than
    // showing a stale label from the caller's dropdown.
    let scopeLabel = 'All offerings';
    if (scope.type === 'category') {
      scopeLabel = scope.category === 'product' ? 'All products' : 'All services';
    } else if (scope.type === 'uncategorized') {
      scopeLabel = UNCATEGORIZED_LABEL;
    } else if (scope.type === 'offering') {
      const [row] = await tx
        .select({ name: offerings.name })
        .from(offerings)
        .where(
          and(
            eq(offerings.tenantId, tenantId),
            eq(offerings.id, scope.offeringId),
          ),
        )
        .limit(1);
      scopeLabel = row?.name ?? 'Unknown offering';
    }

    return {
      stageRows,
      rollupRows,
      uncategorized: {
        dealCount: Number(uncategorizedRow?.dealCount ?? 0),
        totalAmountMinor: Number(uncategorizedRow?.totalAmountMinor ?? 0),
      },
      allDeals: {
        dealCount: Number(allRow?.dealCount ?? 0),
        totalAmountMinor: Number(allRow?.totalAmountMinor ?? 0),
      },
      overlapDealCount: Number(overlapRow?.n ?? 0),
      scopeLabel,
    };
  });

  // Pad the missing stages with zeros. An empty stage is a hole in the funnel
  // and has to be visible as one — dropping the row would silently reshape
  // the chart's axis between two runs of the same report.
  const byStage = new Map<DealStage, { count: number; totalAmountMinor: number }>();
  for (const r of stageRows) {
    byStage.set(r.stage as DealStage, {
      count: Number(r.count),
      totalAmountMinor: Number(r.totalAmountMinor),
    });
  }
  const rows: FunnelByOfferingRow[] = DEAL_STAGES.map((stage) => {
    const v = byStage.get(stage) ?? { count: 0, totalAmountMinor: 0 };
    return {
      stage,
      stageLabel: DEAL_STAGE_LABELS[stage],
      count: v.count,
      totalAmountMinor: v.totalAmountMinor,
    };
  });

  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalAmountMinor = rows.reduce((s, r) => s + r.totalAmountMinor, 0);
  const settings = await getOrgSettings(tenantId);

  return {
    rows,
    extras: {
      scope,
      scopeLabel,
      rollup: rollupRows.map((r) => ({
        offeringId: r.offeringId,
        offeringName: r.offeringName,
        category: r.category as OfferingCategory,
        active: r.active,
        dealCount: Number(r.dealCount),
        totalAmountMinor: Number(r.totalAmountMinor),
        openDealCount: Number(r.openDealCount),
        openAmountMinor: Number(r.openAmountMinor),
      })),
      uncategorized,
      allDeals,
      overlapDealCount,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount,
      headline: {
        label: `${scopeLabel} · ${totalCount} deals`,
        value: formatTenantCurrency(totalAmountMinor, settings),
      },
    },
  };
};

/**
 * The scope predicate, as a semi-join rather than a join to `deal_offerings`.
 *
 * EXISTS matters twice over. A join would multiply a bundle deal into one row
 * per matching tag, so a deal tagged with two selected offerings would be
 * counted — and its amount summed — twice within the SAME funnel. And a join
 * on `is_primary` (the other tempting shortcut) would quietly redefine the
 * report as "deals whose primary is X", hiding every bundle from a funnel it
 * belongs in.
 */
function scopeCondition(scope: FunnelScope): SQL | null {
  switch (scope.type) {
    case 'all':
      return null;
    case 'uncategorized':
      return uncategorizedCondition();
    case 'offering':
      return sql`EXISTS (
        SELECT 1 FROM ${dealOfferings} dof
        WHERE dof.tenant_id = ${deals.tenantId}
          AND dof.deal_id = ${deals.id}
          AND dof.offering_id = ${scope.offeringId}::uuid
      )`;
    case 'category':
      return sql`EXISTS (
        SELECT 1 FROM ${dealOfferings} dof
        JOIN ${offerings} o ON o.id = dof.offering_id
        WHERE dof.tenant_id = ${deals.tenantId}
          AND dof.deal_id = ${deals.id}
          AND o.category = ${scope.category}::offering_category
      )`;
  }
}

/** The exact complement of every tagged scope: tagged + untagged = all deals. */
function uncategorizedCondition(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${dealOfferings} dof
    WHERE dof.tenant_id = ${deals.tenantId} AND dof.deal_id = ${deals.id}
  )`;
}

/** Same shape as the other runners'; see `pipeline-by-stage` for why it isn't shared. */
function buildOwnerCondition(
  owner: OwnerScope | undefined,
  currentUserId: string,
): SQL | null {
  if (!owner) return null;
  if (owner.type === 'all') return null;
  if (owner.type === 'mine') return eq(deals.ownerId, currentUserId);
  return eq(deals.ownerId, owner.userId);
}
