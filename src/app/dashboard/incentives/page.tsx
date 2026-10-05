import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { canViewTeamIncentives } from '@/lib/incentives/access';
import { fmtCr, fmtL, fmtPct } from '@/lib/incentives/format';
import { getTemplate, latestActualsForPlans, listPlans, rowToTerms } from '@/lib/incentives/queries';
import { buildRollup, type PlanStatus } from '@/lib/incentives/rollup';
import { actualsInput } from '@/lib/incentives/types';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { can } from '@/lib/rbac';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { FiscalYearSelect } from '../targets/_components/fy-select';
import { Tile } from './_components/incentive-calculator';

export const metadata = { title: 'Incentives' };

/**
 * Manager/admin roll-up. Every number is a `buildRollup` output, which is one
 * `calculateIncentive` run per resource plus exact sums of those runs — the
 * total on this page is, by construction, the sum of the rows below it.
 */
export default async function IncentivesRollupPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  await requirePersonas(['admin', 'manager']);
  return await withTenantSession(async ({ tenant }) => {
    const membership = await requireMembership();
    if (!canViewTeamIncentives(membership.role)) {
      throw new Error('You do not have access to the incentive roll-up.');
    }
    const isAdmin = can(membership.role, 'manageIncentives');
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    const choices = fiscalYearChoices(startMonth, now);
    const sp = await searchParams;
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy) ? parsedFy : currentFiscalYear(startMonth, now);
    const label = fiscalYearLabel(startMonth, fiscalYear);

    const [plans, teammates, template] = await Promise.all([
      listPlans(tenant.id, fiscalYear),
      listTeammates(tenant.id, tenant.name),
      getTemplate(tenant.id),
    ]);
    const live = plans.filter((p) => p.status !== 'draft');
    const actuals = await latestActualsForPlans(tenant.id, live);
    const nameOf = new Map(teammates.map((t) => [t.id, t.displayName]));

    const { rows, totals } = buildRollup(
      live.map((p) => {
        const a = actuals.get(p.id);
        return {
          planId: p.id,
          userId: p.userId,
          displayName: nameOf.get(p.userId) ?? p.userId,
          status: p.status as PlanStatus,
          terms: rowToTerms(p),
          actuals: a ? actualsInput(a) : null,
        };
      }),
      { budgetL: template.budgetL },
    );
    rows.sort((a, b) => (b.result?.finalPayoutL ?? -1) - (a.result?.finalPayoutL ?? -1));
    const drafts = plans.length - live.length;

    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Incentives · {label}
            </h1>
            <p className="mt-0.5 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Projected payout per resource at current actuals. Active and closed plans only
              {drafts > 0 ? ` — ${drafts} draft plan${drafts === 1 ? '' : 's'} not shown` : ''}.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin ? (
              <Link
                href={`/dashboard/settings/incentives?fy=${fiscalYear}`}
                className="text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
              >
                Manage plans →
              </Link>
            ) : null}
            <FiscalYearSelect
              value={fiscalYear}
              choices={choices.map((y) => ({ value: y, label: fiscalYearLabel(startMonth, y) }))}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile label="Projected incentive spend" value={fmtL(totals.projectedPayoutL)} sub={`target variable ${fmtL(totals.targetVariableL)}`} tone="accent" />
          <Tile
            label="vs budget"
            value={totals.budgetL == null ? 'No budget set' : fmtL(totals.budgetRemainingL)}
            sub={totals.budgetL == null ? 'set it on the template' : `${totals.budgetRemainingL! < 0 ? 'over' : 'left'} of ${fmtL(totals.budgetL)}`}
            tone={totals.budgetRemainingL != null && totals.budgetRemainingL < 0 ? 'warn' : undefined}
          />
          <Tile label="Resources" value={String(totals.resources)} sub={totals.missingActuals ? `${totals.missingActuals} without actuals` : 'all with actuals'} />
          <Tile label="Below the gate" value={String(totals.belowGate)} tone={totals.belowGate ? 'warn' : undefined} />
          <Tile label="Missing margin floor" value={String(totals.marginMiss)} tone={totals.marginMiss ? 'warn' : undefined} />
          <Tile label="On track to exceed target" value={String(totals.breach)} tone={totals.breach ? 'good' : undefined} />
        </div>

        <div className="mt-5 overflow-x-auto rounded-lg border border-slate-200 dark:border-[#1F1F1F]">
          <table className="w-full text-[13px] tabular-nums">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
              <tr>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 text-right font-medium">Credited</th>
                <th className="px-3 py-2 text-right font-medium">Needed for 100%</th>
                <th className="px-3 py-2 text-right font-medium">Margin</th>
                <th className="px-3 py-2 text-right font-medium">Projected payout</th>
                <th className="px-3 py-2 text-right font-medium">% of target</th>
                <th className="px-3 py-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-500 dark:text-[#A1A1AA]">
                    No active incentive plans for {label}.
                    {isAdmin ? ' Create them under Settings → Incentives.' : ''}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.planId} className="border-t border-slate-100 dark:border-[#1F1F1F]">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/incentives/${r.planId}`} className="font-medium text-slate-800 hover:text-indigo-600 dark:text-[#FAFAFA]">
                        {r.displayName}
                      </Link>
                      {r.status === 'closed' ? <span className="ml-2 text-[11px] text-slate-400">closed</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right">{r.result ? fmtCr(r.result.creditedRevenue) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {r.needed.reachable ? fmtCr(r.needed.creditedRevenueCr) : <span className="text-amber-600">unreachable</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.actuals ? fmtPct(Number(r.actuals.blendedMarginPct)) : '—'}
                      <span className="ml-1 text-[11px] text-slate-400">/ {fmtPct(Number(r.terms.marginFloorPct), 0)}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{r.result ? fmtL(r.result.finalPayoutL) : '—'}</td>
                    <td className="px-3 py-2 text-right">{r.result ? fmtPct(r.result.payoutPctOfTarget, 0) : '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {!r.actuals ? <Flag tone="muted">no actuals</Flag> : null}
                        {r.error ? <Flag tone="bad">error</Flag> : null}
                        {r.flags?.belowGate ? <Flag tone="warn">below gate</Flag> : null}
                        {r.flags?.marginMiss ? <Flag tone="bad">margin miss</Flag> : null}
                        {r.flags?.breach ? <Flag tone="good">exceeding target</Flag> : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 ? (
              <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-[#2A2A2A] dark:bg-[#0A0A0A]">
                <tr>
                  <td className="px-3 py-2" colSpan={4}>Total</td>
                  <td className="px-3 py-2 text-right">{fmtL(totals.projectedPayoutL)}</td>
                  <td className="px-3 py-2" colSpan={2} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </main>
    );
  });
}

function Flag({ tone, children }: { tone: 'warn' | 'bad' | 'good' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'warn' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
        tone === 'bad' && 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
        tone === 'good' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
        tone === 'muted' && 'bg-slate-100 text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]',
      )}
    >
      {children}
    </span>
  );
}
