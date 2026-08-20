import { ArrowRight, Info } from 'lucide-react';
import Link from 'next/link';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import {
  FORECAST_CATEGORY_LABELS,
  type ForecastCategory,
} from '@/lib/deals/forecast/categories';
import type { ForecastRollup } from '@/lib/deals/forecast/rollup';
import { cn } from '@/lib/utils';

/**
 * Forecast categories against the system's own projection.
 *
 * TWO WAYS OF ANSWERING "WHAT WILL WE CLOSE", SIDE BY SIDE:
 *
 *   Categorised — the full value of every deal filed under Commit /
 *     Best case / Pipeline. Reflects a judgement about which deals are
 *     really landing, and counts each at 100% of its amount.
 *
 *   System projection — the same deals weighted by their stage's win
 *     probability (`organization_settings.stage_probabilities`). Makes
 *     no judgement about any individual deal; just applies the
 *     historical odds of the stage it currently sits in.
 *
 * The gap between them IS the content. A Commit column far above the
 * weighted projection means deals are being committed earlier than
 * their stage warrants — happy talk, or genuine inside knowledge, and
 * the number itself cannot tell you which. Far below means the team is
 * sandbagging. Neither column is "the forecast"; the distance is the
 * thing worth a conversation.
 *
 * HOW MUCH OF THIS IS HUMAN. `deals.forecast_category` is auto-derived
 * from stage unless someone deliberately overrode it, so a category
 * column can look like submitted judgement while being pure stage
 * machinery wearing a different label. The header states the override
 * count out loud, and when it is zero it says so plainly rather than
 * letting the table imply a commitment nobody made.
 *
 * Setting a category is currently `manageForecast` — manager and admin
 * only. Reps cannot submit a forecast on their own deals. That is why
 * this is labeled "Categorised" rather than "Rep-submitted": naming a
 * column after a workflow the product does not have would be the same
 * class of bug as everything else this pass removed.
 *
 * Rendered only where `forecastsEnabled` is on (Module 4 flag).
 */

/** Forward-looking columns. `closed_won` is banked, `omitted` is out. */
const COLUMNS: ForecastCategory[] = ['commit', 'best_case', 'pipeline'];

export function ForecastBreakdownCard({
  rollup,
  currency,
  periodLabel,
  className,
}: {
  rollup: ForecastRollup;
  currency: TenantCurrencyContext;
  /** e.g. "Q3 FY2026 · 1 Oct – 31 Dec 2026". */
  periodLabel: string;
  className?: string;
}) {
  const money = (m: number) =>
    currency.compactNumbers
      ? formatCompactTenantCurrency(m, currency)
      : formatTenantCurrency(m, currency);
  const exact = (m: number) => formatTenantCurrency(m, currency);

  const rows = COLUMNS.map((category) => {
    const cell = rollup.categoryTotals[category];
    return {
      category,
      label: FORECAST_CATEGORY_LABELS[category],
      count: cell.count,
      categorisedMinor: cell.amountMinor,
      projectedMinor: cell.weightedMinor,
      // Weighted can only be ≤ raw (probabilities are ≤100), so this is
      // "how much of the categorised value the odds don't support".
      gapMinor: cell.amountMinor - cell.weightedMinor,
    };
  });

  const totalCategorised = rows.reduce((s, r) => s + r.categorisedMinor, 0);
  const totalProjected = rows.reduce((s, r) => s + r.projectedMinor, 0);
  const anyDeals = rows.some((r) => r.count > 0);

  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
      aria-label={`Forecast categories · ${periodLabel}`}
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Forecast categories
          </h2>
          <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {periodLabel} · on expected close date
          </p>
        </div>
        <Link
          href="/dashboard/executive/forecast"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Full forecast <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      {!anyDeals ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-[11.5px] text-slate-500 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
          No open deals carry an expected close date in {periodLabel}. Set close
          dates on open deals and the forecast fills in here.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:border-[#1F1F1F] dark:text-[#71717A]">
                  <th className="pb-1.5 text-left font-semibold">Category</th>
                  <th
                    className="pb-1.5 text-right font-semibold"
                    title="Full value of every deal filed in this category, counted at 100%."
                  >
                    Categorised
                  </th>
                  <th
                    className="pb-1.5 text-right font-semibold"
                    title="The same deals weighted by their stage's configured win probability. No per-deal judgement — just the odds of the stage each one sits in."
                  >
                    System projection
                  </th>
                  <th
                    className="pb-1.5 text-right font-semibold"
                    title="Categorised minus projected — the portion of the categorised value the stage odds do not support."
                  >
                    Gap
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
                {rows.map((r) => (
                  <tr key={r.category}>
                    <td className="py-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-[#A1A1AA]">
                        {r.label}
                      </span>
                      <span className="ml-1.5 text-[10.5px] text-slate-400 dark:text-[#71717A]">
                        {r.count} {r.count === 1 ? 'deal' : 'deals'}
                      </span>
                    </td>
                    <td
                      className="py-2 text-right font-mono tabular-nums text-slate-900 dark:text-[#FAFAFA]"
                      title={exact(r.categorisedMinor)}
                    >
                      {money(r.categorisedMinor)}
                    </td>
                    <td
                      className="py-2 text-right font-mono tabular-nums text-slate-600 dark:text-[#A1A1AA]"
                      title={exact(r.projectedMinor)}
                    >
                      {money(r.projectedMinor)}
                    </td>
                    <td
                      className="py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300"
                      title={`${exact(r.gapMinor)} of categorised value is not supported by stage probability.`}
                    >
                      {r.gapMinor === 0 ? '—' : `−${money(r.gapMinor)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 dark:border-[#2A2A2A]">
                  <td className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                    Total
                  </td>
                  <td
                    className="pt-2 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]"
                    title={exact(totalCategorised)}
                  >
                    {money(totalCategorised)}
                  </td>
                  <td
                    className="pt-2 text-right font-mono font-semibold tabular-nums text-slate-600 dark:text-[#A1A1AA]"
                    title={exact(totalProjected)}
                  >
                    {money(totalProjected)}
                  </td>
                  <td
                    className="pt-2 text-right font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-300"
                    title={exact(totalCategorised - totalProjected)}
                  >
                    {totalCategorised === totalProjected
                      ? '—'
                      : `−${money(totalCategorised - totalProjected)}`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {rollup.overdue.count > 0 ? (
            <p className="mt-2.5 text-[10.5px] text-amber-700 dark:text-amber-300">
              {rollup.overdue.count}{' '}
              {rollup.overdue.count === 1 ? 'deal is' : 'deals are'} open with a
              close date already in the past
              {/* These are frequently the same unpriced deals the
                  Attention Queue flags, so the total is often 0. Saying
                  "worth ₹0" would assert a value nobody entered. */}
              {rollup.overdue.amountMinor > 0
                ? `, worth ${money(rollup.overdue.amountMinor)}`
                : ' (no amount recorded on any of them)'}
              . They are excluded from every figure above until they are
              re-forecast.
            </p>
          ) : null}

          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-snug text-slate-500 dark:text-[#71717A]">
            <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            <span>
              {rollup.overriddenCount === 0
                ? 'Every deal above is categorised automatically from its stage — no one has overridden a category in this period, so "Categorised" carries no human judgement yet.'
                : `${rollup.overriddenCount} of ${rollup.grandTotal.count} deals were categorised manually; the rest follow their stage.`}{' '}
              Categories are set by managers and admins — reps cannot submit
              their own.
            </span>
          </p>
        </>
      )}
    </section>
  );
}
