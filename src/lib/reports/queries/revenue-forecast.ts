import 'server-only';

import { sql } from 'drizzle-orm';

import { formatTenantCurrency } from '@/lib/currency/format';
import { tenantTransaction } from '@/lib/db-context';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { resolveDateRange } from '../filters';
import type { ReportFilter, ReportRunner } from '../types';

/**
 * Revenue Forecast — weighted pipeline projection grouped by close
 * month. For each open deal with an `expected_close_date` in the
 * window, computes `amount_minor * probability / 100`. Bucketed by
 * `date_trunc('month', expected_close_date)`.
 *
 * Stage default probability is applied at query time for any row
 * with NULL — that lets us roll out the migration without a forced
 * UPDATE pass on the full table (the partial backfill in 0015 handles
 * existing rows; this protects against rows inserted via outdated
 * code paths that don't yet set probability).
 *
 * Three projection lines:
 *   - Likely     = sum(amount × probability/100)            (default forecast)
 *   - Best case  = sum(amount)                              (every deal closes)
 *   - Worst case = sum(amount × prob/100) for prob >= 50    (only high-confidence)
 *
 * Window applies to `expected_close_date`. Default range: next_180d.
 */
export type RevenueForecastRow = {
  monthIso: string; // ISO yyyy-mm-01
  monthLabel: string; // "May 2026"
  likelyMinor: number; // weighted forecast
  bestCaseMinor: number; // unweighted
  worstCaseMinor: number; // only deals with prob >= 50
  dealCount: number;
};

export type RevenueForecastExtras = {
  windowFrom: string;
  windowTo: string;
  totalLikelyMinor: number;
  totalBestCaseMinor: number;
  totalWorstCaseMinor: number;
  totalDeals: number;
  /** A simple confidence score 0-1: avg probability across the forecasted deals. */
  avgConfidence: number;
};

export const revenueForecastRunner: ReportRunner<
  ReportFilter,
  RevenueForecastRow,
  RevenueForecastExtras
> = async (tenantId, filters, _context) => {
  const startedAt = Date.now();
  // For a forecast, the natural default is the NEXT N days, not the
  // last N. The shared `resolveDateRange` helper is past-window-shaped
  // so we compute the forward window inline.
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const range = (() => {
    if (
      filters.range &&
      typeof filters.range === 'object' &&
      'from' in filters.range &&
      'to' in filters.range
    ) {
      return {
        from: new Date(filters.range.from),
        to: new Date(filters.range.to),
      };
    }
    // Forward window presets: reuse the preset name but interpret
    // forward of "now" rather than backward.
    const preset = (filters.range as string) ?? 'next_180d';
    const days =
      preset === 'last_30d' || preset === 'next_30d'
        ? 30
        : preset === 'last_90d' || preset === 'next_90d'
          ? 90
          : preset === 'this_quarter'
            ? 92
            : preset === 'this_year'
              ? 365
              : 180; // default: 6 months ahead
    const to = new Date(todayUtc);
    to.setUTCDate(to.getUTCDate() + days);
    return { from: todayUtc, to };
  })();

  // Reference the shared resolver so the import isn't unused — kept
  // for parity with reports that use past windows.
  void resolveDateRange;

  type RawRow = {
    monthIso: string;
    likelyMinor: string;
    bestCaseMinor: string;
    worstCaseMinor: string;
    dealCount: string;
  };

  const fromIso = range.from.toISOString().slice(0, 10);
  const toIso = range.to.toISOString().slice(0, 10);

  const raw = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH forecasted AS (
        SELECT
          date_trunc('month', expected_close_date)::date AS month,
          amount_minor,
          coalesce(
            probability,
            CASE stage
              WHEN 'lead'        THEN 10
              WHEN 'qualified'   THEN 25
              WHEN 'proposal'    THEN 50
              WHEN 'negotiation' THEN 75
              ELSE 0
            END
          ) AS prob_pct
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND stage IN ('lead', 'qualified', 'proposal', 'negotiation')
          AND expected_close_date IS NOT NULL
          AND expected_close_date >= ${fromIso}::date
          AND expected_close_date <  ${toIso}::date
      )
      SELECT
        to_char(month, 'YYYY-MM-DD')                            AS "monthIso",
        coalesce(sum(amount_minor * prob_pct / 100), 0)::bigint AS "likelyMinor",
        coalesce(sum(amount_minor), 0)::bigint                  AS "bestCaseMinor",
        coalesce(
          sum(amount_minor * prob_pct / 100)
            FILTER (WHERE prob_pct >= 50),
          0
        )::bigint                                                AS "worstCaseMinor",
        count(*)::int                                            AS "dealCount"
      FROM forecasted
      GROUP BY month
      ORDER BY month ASC
    `),
  )) as unknown as RawRow[];

  // Generate month buckets across the window so a quiet month still
  // shows up as a zero — line charts need a stable x-axis.
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1),
  );
  while (cursor < range.to) {
    months.push(
      `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-01`,
    );
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const byMonth = new Map<string, RawRow>();
  for (const r of raw) byMonth.set(r.monthIso, r);

  const monthLabelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  });

  const rows: RevenueForecastRow[] = months.map((iso) => {
    const r = byMonth.get(iso);
    return {
      monthIso: iso,
      monthLabel: monthLabelFmt.format(new Date(iso + 'T00:00:00Z')),
      likelyMinor: Number(r?.likelyMinor ?? 0),
      bestCaseMinor: Number(r?.bestCaseMinor ?? 0),
      worstCaseMinor: Number(r?.worstCaseMinor ?? 0),
      dealCount: Number(r?.dealCount ?? 0),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      likely: acc.likely + r.likelyMinor,
      best: acc.best + r.bestCaseMinor,
      worst: acc.worst + r.worstCaseMinor,
      deals: acc.deals + r.dealCount,
    }),
    { likely: 0, best: 0, worst: 0, deals: 0 },
  );
  const avgConfidence =
    totals.best === 0 ? 0 : Math.min(1, totals.likely / totals.best);

  return {
    rows,
    extras: {
      windowFrom: range.from.toISOString(),
      windowTo: range.to.toISOString(),
      totalLikelyMinor: totals.likely,
      totalBestCaseMinor: totals.best,
      totalWorstCaseMinor: totals.worst,
      totalDeals: totals.deals,
      avgConfidence,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: totals.deals,
      headline: {
        label: `${totals.deals} deals`,
        value:
          totals.deals === 0
            ? '—'
            : `${formatTenantCurrency(totals.likely, await getOrgSettings(tenantId))} likely`,
      },
    },
  };
};
