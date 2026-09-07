import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { formatTenantCurrency } from '@/lib/currency/format';
import { getRiskSummary, listAtRiskDeals } from '@/lib/deals/risk/queries';
import {
  RISK_BAND_LABELS,
  RISK_ELEVATED_FROM,
  RISK_HIGH_FROM,
  type RiskBand,
} from '@/lib/deals/risk/score';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

export const metadata = { title: 'At Risk Deals' };

const BAND_CHIP: Record<RiskBand, string> = {
  low: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  elevated:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  high: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
};

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/**
 * AT RISK DEALS — the open pipeline ordered by the Phase 1 risk score.
 *
 * A separate page rather than a sort on the Deals list, and that is a real
 * constraint rather than a preference: the list paginates by a keyset cursor
 * on `(created_at, id)`, so re-ordering it by a column in another table would
 * break the cursor for every page after the first. This view owns its own
 * ordering and its own (small) result set.
 *
 * Scoped like the Deals list: a sales persona sees only their own deals. A
 * cross-rep risk ranking is a manager's tool, and handing every rep a
 * leaderboard of their colleagues' worst deals is not what this is for.
 */
export default async function AtRiskDealsPage({
  searchParams,
}: {
  searchParams: Promise<{ band?: string }>;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const onlyMine = persona === 'sales' ? userId : null;

    const sp = await searchParams;
    // Default to Elevated and above: a list that included every deal with one
    // minor factor would just be the deal list with an extra column.
    const minScore = sp.band === 'high' ? RISK_HIGH_FROM : RISK_ELEVATED_FROM;

    const [rows, summary, settings, teammates] = await Promise.all([
      listAtRiskDeals(tenant.id, { minScore, ownerId: onlyMine, limit: 150 }),
      getRiskSummary(tenant.id),
      getOrgSettings(tenant.id),
      listTeammates(tenant.id, tenant.name),
    ]);

    const ctx = {
      defaultCurrency: settings.defaultCurrency,
      currencyLocale: settings.currencyLocale,
      compactNumbers: settings.compactNumbers,
    };
    const nameById = new Map(teammates.map((t) => [t.id, t.displayName]));

    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              <AlertTriangle className="h-4 w-4 text-slate-400" aria-hidden />
              At risk deals
            </h1>
            {/* What the number is, and which way it points — before the
                number itself. */}
            <p className="mt-0.5 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Open deals ranked by a rules-based risk score (0–100, higher is
              worse) built from pushbacks, silence, missing fields, time in
              stage and deal age. Not a trained model — every point is
              attributable, and the factors behind each score are listed.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            <BandLink current={sp.band} value={undefined} label={`Elevated+ (${summary.elevated + summary.high})`} />
            <BandLink current={sp.band} value="high" label={`High only (${summary.high})`} />
          </div>
        </div>

        <p className="mt-2 text-[11.5px] text-slate-400 dark:text-[#71717A]">
          {summary.scored > 0 ? (
            <>
              {summary.scored} open {summary.scored === 1 ? 'deal' : 'deals'}{' '}
              scored
              {summary.lastComputedAt
                ? ` · last run ${dateFmt.format(new Date(summary.lastComputedAt))} UTC`
                : ''}
              {summary.explained > 0
                ? ` · ${summary.explained} with a written summary`
                : ' · summaries assembled from factors (no Claude key configured)'}
            </>
          ) : (
            'No deal has been scored yet — the nightly job has not run for this workspace.'
          )}
        </p>

        {rows.length === 0 ? (
          <p className="mt-5 rounded-lg border border-slate-200 bg-white p-8 text-center text-[13px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
            {summary.scored === 0
              ? 'Nothing scored yet. Scores are written nightly.'
              : 'No open deal is above the risk threshold. That is the good outcome.'}
          </p>
        ) : (
          <ul className="mt-5 space-y-2">
            {rows.map((r) => (
              <li
                key={r.dealId}
                className="rounded-lg border border-slate-200 bg-white p-3.5 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/deals/${r.dealId}`}
                      className="text-[13.5px] font-semibold text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                    >
                      {r.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                      {r.companyName ? <span>{r.companyName}</span> : null}
                      <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
                      <span>{DEAL_STAGE_LABELS[r.stage] ?? r.stage}</span>
                      <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
                      <span className="tabular-nums">
                        {formatTenantCurrency(r.amountMinor, ctx, {
                          currency: r.currency,
                        })}
                      </span>
                      {r.ownerId ? (
                        <>
                          <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
                          <span>{nameById.get(r.ownerId) ?? 'Unassigned'}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
                        BAND_CHIP[r.band],
                      )}
                    >
                      {RISK_BAND_LABELS[r.band]}
                    </span>
                    <span className="font-mono text-[17px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                      {r.score}
                    </span>
                  </div>
                </div>

                <p className="mt-2 text-[12.5px] leading-relaxed text-slate-700 dark:text-[#D4D4D8]">
                  {r.explanation}
                </p>

                {/* The factor chips are the receipt for the sentence above:
                    every number in it should be traceable to one of these. */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.factors.map((f) => (
                    <span
                      key={f.key}
                      title={f.detail}
                      className="inline-flex items-center gap-1 rounded bg-slate-50 px-1.5 py-0.5 text-[10.5px] text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-[#151515] dark:text-[#A1A1AA] dark:ring-[#262626]"
                    >
                      {f.label}
                      <span className="tabular-nums text-slate-400">+{f.points}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    );
  });
}

function BandLink({
  current,
  value,
  label,
}: {
  current: string | undefined;
  value: 'high' | undefined;
  label: string;
}) {
  const active = (current === 'high' ? 'high' : undefined) === value;
  return (
    <Link
      href={value ? '/dashboard/deals/at-risk?band=high' : '/dashboard/deals/at-risk'}
      className={cn(
        'rounded-md px-2 py-1 font-medium transition-colors',
        active
          ? 'bg-slate-900 text-white dark:bg-[#FAFAFA] dark:text-[#0A0A0A]'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#A1A1AA] dark:hover:bg-[#151515] dark:hover:text-[#FAFAFA]',
      )}
    >
      {label}
    </Link>
  );
}
