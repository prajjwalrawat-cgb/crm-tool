'use client';

import { AlertTriangle, Info } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import { formatNumber } from '@/lib/dates/format';
import type { FunnelScope } from '@/lib/reports/funnel-scope';
import type {
  FunnelByOfferingExtras,
  FunnelByOfferingRow,
} from '@/lib/reports/queries/funnel-by-offering';
import {
  groupByCategory,
  OFFERING_CATEGORY_CHIP,
  OFFERING_CATEGORY_LABELS,
  OFFERING_CATEGORY_PLURAL,
  type OfferingOption,
  UNCATEGORIZED_LABEL,
} from '@/lib/offerings/types';
import { cn } from '@/lib/utils';

/**
 * Funnel by offering — the scope controls, the stage funnel, and the coverage
 * panel that keeps the numbers honest.
 *
 * The layout is deliberate: the per-offering rollup and the Uncategorized
 * total sit on the SAME screen as the funnel, not behind a tab. On day one
 * most of the pipeline is untagged, and a per-offering number read without
 * that context is confidently wrong.
 */
export function OfferingFunnelSection({
  rows,
  extras,
  offeringOptions,
  mode,
  currency,
}: {
  rows: FunnelByOfferingRow[];
  extras: FunnelByOfferingExtras;
  offeringOptions: OfferingOption[];
  mode: 'count' | 'amount';
  currency: TenantCurrencyContext;
}) {
  const coveredValue =
    extras.allDeals.totalAmountMinor - extras.uncategorized.totalAmountMinor;
  const coveragePct =
    extras.allDeals.totalAmountMinor > 0
      ? Math.round((coveredValue / extras.allDeals.totalAmountMinor) * 100)
      : 0;

  return (
    <div className="space-y-4">
      <ScopeBar scope={extras.scope} options={offeringOptions} />

      {/* -------- the funnel -------- */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <h2 className="text-[12.5px] font-semibold text-slate-800">
            {extras.scopeLabel}
          </h2>
          <span className="text-[11px] text-slate-500">
            Live snapshot — every stage, not a time window
          </span>
        </header>
        <FunnelBars rows={rows} mode={mode} currency={currency} />
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Stage</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Deals</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                key={row.stage}
                className={cn(
                  'transition-colors hover:bg-slate-50/70',
                  row.count === 0 && 'text-slate-400',
                )}
              >
                <td className="px-3 py-2 font-medium">{row.stageLabel}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatNumber(row.count)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatTenantCurrency(row.totalAmountMinor, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* -------- coverage -------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <h2 className="mb-2 text-[12.5px] font-semibold text-slate-800">
          Coverage
        </h2>
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat
            label="All deals"
            primary={formatTenantCurrency(
              extras.allDeals.totalAmountMinor,
              currency,
            )}
            secondary={`${formatNumber(extras.allDeals.dealCount)} deals`}
          />
          <Stat
            label="Tagged"
            primary={formatTenantCurrency(coveredValue, currency)}
            secondary={`${formatNumber(
              extras.allDeals.dealCount - extras.uncategorized.dealCount,
            )} deals · ${coveragePct}% of value`}
          />
          <Stat
            label={UNCATEGORIZED_LABEL}
            primary={formatTenantCurrency(
              extras.uncategorized.totalAmountMinor,
              currency,
            )}
            secondary={`${formatNumber(extras.uncategorized.dealCount)} deals`}
            tone={extras.uncategorized.dealCount > 0 ? 'warn' : 'plain'}
          />
        </div>
        {extras.uncategorized.dealCount > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {formatNumber(extras.uncategorized.dealCount)} deal
              {extras.uncategorized.dealCount === 1 ? '' : 's'} carry no
              offering and are missing from every funnel above. There is no
              bulk backfill by design —{' '}
              <Link
                href="/dashboard/deals?uncategorized=1"
                className="font-medium underline underline-offset-2"
              >
                open the Uncategorized list
              </Link>{' '}
              and tag them as you go.
            </span>
          </p>
        ) : null}
      </section>

      {/* -------- per-offering rollup -------- */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <h2 className="text-[12.5px] font-semibold text-slate-800">
            By offering
          </h2>
          <span className="text-[11px] text-slate-500">
            Highest value first
          </span>
        </header>
        {extras.overlapDealCount > 0 ? (
          <p className="flex items-start gap-1.5 border-b border-slate-100 bg-slate-50/60 px-3 py-2 text-[11.5px] text-slate-600">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            <span>
              {formatNumber(extras.overlapDealCount)} deal
              {extras.overlapDealCount === 1 ? ' is' : 's are'} tagged with more
              than one offering and count in full toward each — so these rows
              add up to more than total pipeline. That is the intended reading:
              a bundle deal is a real opportunity for every offering in it.
            </span>
          </p>
        ) : null}
        {extras.rollup.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-slate-500">
            No tagged deals in this scope yet.
          </p>
        ) : (
          <table className="min-w-full divide-y divide-slate-100 text-[13px]">
            <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Offering</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Deals</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Total value</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Still open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {extras.rollup.map((r) => (
                <tr key={r.offeringId} className="transition-colors hover:bg-slate-50/70">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1 py-0 text-[9.5px] font-medium uppercase tracking-wide',
                          OFFERING_CATEGORY_CHIP[r.category],
                        )}
                      >
                        {OFFERING_CATEGORY_LABELS[r.category]}
                      </span>
                      <span className="font-medium text-slate-800">
                        {r.offeringName}
                      </span>
                      {/* A retired offering keeps its funnel — it just can't
                          be tagged onto anything new. Saying so here stops
                          "why is ProcureFlow still in the report" from
                          becoming a bug report. */}
                      {!r.active ? (
                        <span
                          className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-600"
                          title="Retired from the catalog — historical deals keep it"
                        >
                          Retired
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatNumber(r.dealCount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatTenantCurrency(r.totalAmountMinor, currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">
                    {r.openDealCount === 0
                      ? '—'
                      : formatTenantCurrency(r.openAmountMinor, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/**
 * Horizontal bars, sized against the largest stage. A funnel drawn against a
 * fixed maximum would be flat for every small offering, which is the case
 * this report is most often opened for.
 */
function FunnelBars({
  rows,
  mode,
  currency,
}: {
  rows: FunnelByOfferingRow[];
  mode: 'count' | 'amount';
  currency: TenantCurrencyContext;
}) {
  const value = (r: FunnelByOfferingRow) =>
    mode === 'count' ? r.count : r.totalAmountMinor;
  const max = Math.max(...rows.map(value), 0);

  if (max === 0) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-slate-500">
        No deals in this scope.
      </p>
    );
  }

  return (
    <ul className="space-y-1 p-3">
      {rows.map((r) => {
        const v = value(r);
        return (
          <li key={r.stage} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[11px] text-slate-500">
              {r.stageLabel}
            </span>
            <span className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-slate-100">
              <span
                className="block h-full rounded bg-indigo-500/80"
                style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }}
              />
            </span>
            <span className="w-32 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-700">
              {mode === 'count'
                ? formatNumber(r.count)
                : formatTenantCurrency(r.totalAmountMinor, currency)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({
  label,
  primary,
  secondary,
  tone = 'plain',
}: {
  label: string;
  primary: string;
  secondary: string;
  tone?: 'plain' | 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2',
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50/60'
          : 'border-slate-200 bg-slate-50/60',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-slate-900">
        {primary}
      </div>
      <div className="text-[11px] text-slate-500">{secondary}</div>
    </div>
  );
}

/**
 * Product / Service / All toggle plus the specific-offering dropdown.
 *
 * Both write the URL and let the server re-run the report, matching
 * `ReportFilterBar` — the report's scope has to survive a reload and a shared
 * link, and a client-side re-filter of already-fetched rows could not show
 * the per-offering funnel at all (the rows for one offering are a different
 * query, not a subset of the rows for all of them).
 */
function ScopeBar({
  scope,
  options,
}: {
  scope: FunnelScope;
  options: OfferingOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function go(next: { offering?: string; category?: string }) {
    const sp = new URLSearchParams(params?.toString() ?? '');
    // Both keys are always cleared first: the two controls are one scope, and
    // leaving a stale `category` behind a newly picked `offering` is how a
    // filter bar starts contradicting itself.
    sp.delete('offering');
    sp.delete('category');
    if (next.offering) sp.set('offering', next.offering);
    if (next.category) sp.set('category', next.category);
    start(() => {
      router.replace(
        `/dashboard/reports/funnel-by-offering${
          sp.toString() ? `?${sp.toString()}` : ''
        }`,
      );
    });
  }

  const activeCategory =
    scope.type === 'category' ? scope.category : scope.type === 'all' ? 'all' : null;
  const selectedOffering = scope.type === 'offering' ? scope.offeringId : '';

  return (
    <div className={cn('flex flex-wrap items-center gap-2', pending && 'opacity-70')}>
      <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
        <button
          type="button"
          onClick={() => go({})}
          className={cn(
            'px-3 py-1 transition',
            activeCategory === 'all'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-700 hover:bg-slate-50',
          )}
        >
          All
        </button>
        {(['product', 'service'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => go({ category: c })}
            className={cn(
              'px-3 py-1 transition',
              activeCategory === c
                ? 'bg-indigo-600 text-white'
                : 'text-slate-700 hover:bg-slate-50',
            )}
          >
            {OFFERING_CATEGORY_PLURAL[c]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => go({ category: 'uncategorized' })}
          title="Deals with no offering tagged"
          className={cn(
            'px-3 py-1 transition',
            scope.type === 'uncategorized'
              ? 'bg-amber-500 text-white'
              : 'text-slate-700 hover:bg-slate-50',
          )}
        >
          {UNCATEGORIZED_LABEL}
        </button>
      </div>

      <select
        aria-label="Filter to a specific offering"
        value={selectedOffering}
        onChange={(e) =>
          e.target.value ? go({ offering: e.target.value }) : go({})
        }
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700 focus:border-indigo-500 focus:outline-none"
      >
        <option value="">Every offering</option>
        {groupByCategory(options).map(({ category, items }) =>
          items.length === 0 ? null : (
            <optgroup key={category} label={OFFERING_CATEGORY_PLURAL[category]}>
              {items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.active ? '' : ' (retired)'}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </div>
  );
}
