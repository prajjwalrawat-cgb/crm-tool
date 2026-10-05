import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { canEnterManualActuals } from '@/lib/incentives/access';
import { fmtCr, fmtPct } from '@/lib/incentives/format';
import { actualsHistory, listVersions, loadPlanForViewer } from '@/lib/incentives/queries';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { can } from '@/lib/rbac';
import { listTeammates } from '@/lib/teammates/queries';

import { IncentiveCalculator, Panel } from '../_components/incentive-calculator';
import { RecomputeButton } from '../_components/recompute-button';
import { VersionHistory } from '../_components/version-history';

export const metadata = { title: 'Incentive plan' };

/**
 * One resource's calculator, for a manager or admin — or for the resource
 * themselves (a SPOC following a link to their own plan id lands here and
 * sees exactly /my-incentive). Anyone else gets a 404, not a 403, so plan ids
 * can't be probed.
 */
export default async function IncentivePlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const viewer = { userId, role: membership.role };
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const bundle = await loadPlanForViewer(tenant.id, viewer, planId, startMonth);
    if (!bundle) notFound();

    const isAdmin = can(membership.role, 'manageIncentives');
    const own = bundle.plan.userId === userId;
    const [teammates, history, versions] = await Promise.all([
      listTeammates(tenant.id, tenant.name),
      actualsHistory(tenant.id, planId, 30),
      // The audit trail carries CTC changes; it's for the people who manage plans.
      isAdmin || can(membership.role, 'viewTeamIncentives') ? listVersions(tenant.id, planId) : Promise.resolve([]),
    ]);
    const nameOf = new Map(teammates.map((t) => [t.id, t.displayName]));
    const name = nameOf.get(bundle.plan.userId) ?? bundle.plan.userId;
    const who = (id: string | null) => (id ? (nameOf.get(id) ?? (id === 'system' ? 'System' : id)) : 'System');

    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href={`/dashboard/incentives?fy=${bundle.plan.fiscalYear}`} className="text-[12px] text-slate-500 hover:text-indigo-600 dark:text-[#A1A1AA]">
              ← Incentives
            </Link>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {own ? 'My incentive' : name} · {bundle.plan.fiscalLabel}
            </h1>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Plan v{bundle.plan.version} · {bundle.plan.status}
              {bundle.plan.status === 'draft' ? ' — not visible to the resource until activated' : ''}
            </p>
          </div>
          {isAdmin ? (
            <div className="flex items-center gap-2">
              {bundle.plan.actualsSource === 'computed' && bundle.plan.status === 'active' ? (
                <RecomputeButton planId={planId} />
              ) : null}
              <Link
                href={`/dashboard/settings/incentives/plan?planId=${planId}`}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#D4D4D8] dark:hover:bg-[#181818]"
              >
                Edit plan
              </Link>
            </div>
          ) : null}
        </div>

        <IncentiveCalculator
          terms={bundle.plan.terms}
          actuals={bundle.actuals}
          actualsSource={bundle.plan.actualsSource}
          fiscalLabel={bundle.plan.fiscalLabel}
          planId={bundle.plan.id}
          planClosed={bundle.plan.status === 'closed'}
          canEditActuals={canEnterManualActuals(viewer, bundle.plan)}
          enteredByName={bundle.actuals?.enteredBy ? who(bundle.actuals.enteredBy) : null}
          subject={own ? 'self' : 'other'}
        />

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Actuals history">
            {history.length === 0 ? (
              <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">No actuals recorded yet.</p>
            ) : (
              <table className="w-full text-[12px] tabular-nums">
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                  <tr>
                    <th className="py-1 font-medium">As of</th>
                    <th className="py-1 font-medium">Source</th>
                    <th className="py-1 text-right font-medium">Prior-year</th>
                    <th className="py-1 text-right font-medium">Net-new</th>
                    <th className="py-1 text-right font-medium">Margin</th>
                    <th className="py-1 font-medium">By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr
                      key={h.id}
                      className={`border-t border-slate-100 dark:border-[#1F1F1F] ${h.source !== bundle.plan.actualsSource ? 'text-slate-400' : ''}`}
                    >
                      <td className="py-1">{h.asOfDate}</td>
                      <td className="py-1">{h.source}</td>
                      <td className="py-1 text-right">{fmtCr(Number(h.priorYearRevenueCr))}</td>
                      <td className="py-1 text-right">{fmtCr(Number(h.netNewRevenueCr))}</td>
                      <td className="py-1 text-right">{fmtPct(Number(h.blendedMarginPct))}</td>
                      <td className="py-1">{h.source === 'manual' ? who(h.enteredBy) : 'nightly job'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-slate-400 dark:text-[#71717A]">
              Greyed rows are from the source this plan is not reading ({bundle.plan.actualsSource === 'manual' ? 'computed' : 'manual'}).
            </p>
          </Panel>
          {versions.length > 0 ? (
            <Panel title="Plan history (audit)">
              <VersionHistory versions={versions} names={Object.fromEntries(nameOf)} />
            </Panel>
          ) : null}
        </div>
      </main>
    );
  });
}
