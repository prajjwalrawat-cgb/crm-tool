import 'server-only';

import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { deals, type DealStage } from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';

import {
  BEST_CASE_CATEGORIES,
  COMMIT_CATEGORIES,
  FORECAST_CATEGORIES,
  type ForecastCategory,
} from './categories';

export type ForecastCell = {
  amountMinor: number;
  weightedMinor: number;
  count: number;
};

export type ForecastOwnerRow = {
  ownerId: string | null;
  cells: Record<ForecastCategory, ForecastCell>;
  total: ForecastCell;
};

export type ForecastRollup = {
  owners: ForecastOwnerRow[];
  categoryTotals: Record<ForecastCategory, ForecastCell>;
  teamTotal: ForecastCell;
  /** Open deals in-period whose close date already passed — needs re-forecast. */
  overdue: ForecastCell;
  /** commit + closed_won. */
  commit: { rawMinor: number; weightedMinor: number };
  /** commit + closed_won + best_case. */
  bestCase: { rawMinor: number; weightedMinor: number };
  /** Every deal in-period, categories + overdue — used to reconcile with the board. */
  grandTotal: ForecastCell;
  /**
   * How many in-period deals carry a MANUAL forecast category
   * (`forecast_category_overridden`), i.e. how much of this rollup is
   * human judgement rather than stage-derived default.
   *
   * Surfaced so a forecast view can say what it is looking at. Every
   * cell below reads identically whether a manager committed the deal
   * deliberately or the stage machinery filed it there — and a
   * "submitted forecast" that is really 100% auto-derived is a
   * materially different artefact from one a human stands behind.
   */
  overriddenCount: number;
};

function emptyCell(): ForecastCell {
  return { amountMinor: 0, weightedMinor: 0, count: 0 };
}
function emptyCategoryMap(): Record<ForecastCategory, ForecastCell> {
  return Object.fromEntries(
    FORECAST_CATEGORIES.map((c) => [c, emptyCell()]),
  ) as Record<ForecastCategory, ForecastCell>;
}
function addInto(target: ForecastCell, src: ForecastCell): void {
  target.amountMinor += src.amountMinor;
  target.weightedMinor += src.weightedMinor;
  target.count += src.count;
}

export type ForecastRollupParams = {
  tenantId: string;
  /** Inclusive 'YYYY-MM-DD'. */
  startISO: string;
  /** Exclusive 'YYYY-MM-DD'. */
  endISO: string;
  probabilities: Record<DealStage, number>;
  /** Optional owner filter (matrix + overdue both respect it). */
  ownerIds?: string[];
};

/**
 * Build the forecast rollup for a period. Sums `amount_minor` raw (same source
 * as the board) and weights by STAGE probability (board-consistent). Open deals
 * whose close date already passed are partitioned into `overdue` and kept OUT
 * of the category cells / Commit / Best-case — matching the "needs re-forecast"
 * row. `grandTotal` (categories + overdue) reconciles exactly with a board-style
 * Σ amount over the same filters.
 */
export async function getForecastRollup(
  params: ForecastRollupParams,
  exec?: DbExecutor,
): Promise<ForecastRollup> {
  const run = (tx: DbExecutor) => queryRollup(tx, params);
  const rows = exec ? await run(exec) : await tenantTransaction(run);

  const owners = new Map<string | null, ForecastOwnerRow>();
  const categoryTotals = emptyCategoryMap();
  const teamTotal = emptyCell();
  const overdue = emptyCell();
  const grandTotal = emptyCell();
  let overriddenCount = 0;

  for (const r of rows) {
    overriddenCount += Number(r.nOverridden ?? 0);
    const cell: ForecastCell = {
      amountMinor: Number(r.amt ?? 0),
      weightedMinor: Number(r.weighted ?? 0),
      count: Number(r.n ?? 0),
    };
    addInto(grandTotal, cell);

    if (r.overdue) {
      addInto(overdue, cell);
      continue; // overdue deals never land in category cells
    }

    const category = r.category as ForecastCategory;
    let ownerRow = owners.get(r.ownerId);
    if (!ownerRow) {
      ownerRow = { ownerId: r.ownerId, cells: emptyCategoryMap(), total: emptyCell() };
      owners.set(r.ownerId, ownerRow);
    }
    addInto(ownerRow.cells[category], cell);
    addInto(ownerRow.total, cell);
    addInto(categoryTotals[category], cell);
    addInto(teamTotal, cell);
  }

  const sumCats = (cats: ForecastCategory[], key: keyof ForecastCell) =>
    cats.reduce((s, c) => s + categoryTotals[c][key], 0);

  return {
    owners: Array.from(owners.values()),
    categoryTotals,
    teamTotal,
    overdue,
    commit: {
      rawMinor: sumCats(COMMIT_CATEGORIES, 'amountMinor'),
      weightedMinor: sumCats(COMMIT_CATEGORIES, 'weightedMinor'),
    },
    bestCase: {
      rawMinor: sumCats(BEST_CASE_CATEGORIES, 'amountMinor'),
      weightedMinor: sumCats(BEST_CASE_CATEGORIES, 'weightedMinor'),
    },
    grandTotal,
    overriddenCount,
  };
}

type RollupRow = {
  ownerId: string | null;
  category: string;
  overdue: boolean;
  amt: string | number | null;
  weighted: string | number | null;
  n: string | number | null;
  nOverridden: string | number | null;
};

async function queryRollup(
  exec: DbExecutor,
  params: ForecastRollupParams,
): Promise<RollupRow[]> {
  const p = params.probabilities;
  // Stage-probability CASE (board-consistent weighting).
  const probCase = sql`CASE ${deals.stage}
    WHEN 'lead' THEN ${p.lead}
    WHEN 'qualified' THEN ${p.qualified}
    WHEN 'proposal' THEN ${p.proposal}
    WHEN 'negotiation' THEN ${p.negotiation}
    WHEN 'hold' THEN ${p.hold}
    WHEN 'won' THEN ${p.won}
    WHEN 'lost' THEN ${p.lost}
    ELSE 0 END`;
  // Effective category = stored value, else derived from stage (matches
  // deriveForecastCategory). Post-backfill the stored value is always set.
  const effectiveCategory = sql`coalesce(${deals.forecastCategory}, CASE ${deals.stage}
    WHEN 'proposal' THEN 'best_case'
    WHEN 'negotiation' THEN 'commit'
    WHEN 'won' THEN 'closed_won'
    WHEN 'lost' THEN 'omitted'
    WHEN 'hold' THEN 'omitted'
    ELSE 'pipeline' END)`;
  // Held deals are parked with a revisit date (Module 6) — never "overdue".
  const overdueExpr = sql`(${deals.stage} NOT IN ('won','lost','hold') AND ${deals.expectedCloseDate} IS NOT NULL AND ${deals.expectedCloseDate} < CURRENT_DATE)`;

  const conds = [
    eq(deals.tenantId, params.tenantId),
    isNull(deals.deletedAt),
    gte(deals.expectedCloseDate, params.startISO),
    lt(deals.expectedCloseDate, params.endISO),
  ];
  if (params.ownerIds && params.ownerIds.length > 0) {
    conds.push(inArray(deals.ownerId, params.ownerIds));
  }

  const rows = await exec
    .select({
      ownerId: deals.ownerId,
      category: sql<string>`${effectiveCategory}`,
      overdue: sql<boolean>`${overdueExpr}`,
      amt: sql<string>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
      weighted: sql<string>`coalesce(round(sum(${deals.amountMinor} * (${probCase}) / 100.0)), 0)::bigint`,
      n: sql<number>`count(*)::int`,
      nOverridden: sql<number>`count(*) FILTER (WHERE ${deals.forecastCategoryOverridden})::int`,
    })
    .from(deals)
    .where(and(...conds))
    .groupBy(deals.ownerId, sql`${effectiveCategory}`, sql`${overdueExpr}`);

  return rows as RollupRow[];
}
