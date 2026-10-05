import { Wallet } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { canEnterManualActuals } from '@/lib/incentives/access';
import { loadMyPlan } from '@/lib/incentives/queries';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';

import { IncentiveCalculator } from '../incentives/_components/incentive-calculator';
import { FiscalYearSelect } from '../targets/_components/fy-select';

export const metadata = { title: 'My Incentive' };

/**
 * The SPOC's own incentive calculator. No persona guard — anyone can open
 * their own plan; the data is scoped to the signed-in user by `loadMyPlan`,
 * which never takes a user id from the request.
 */
export default async function MyIncentivePage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    const choices = fiscalYearChoices(startMonth, now);
    const sp = await searchParams;
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy)
        ? parsedFy
        : currentFiscalYear(startMonth, now);
    const label = fiscalYearLabel(startMonth, fiscalYear);

    const bundle = await loadMyPlan(tenant.id, userId, fiscalYear, startMonth);

    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              My Incentive
            </h1>
            <p className="mt-0.5 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Your {label} incentive plan: where you stand today, what full payout takes, and what
              over-achievement pays. Figures are projections from current actuals, not a payout statement.
            </p>
          </div>
          <FiscalYearSelect
            value={fiscalYear}
            choices={choices.map((y) => ({ value: y, label: fiscalYearLabel(startMonth, y) }))}
          />
        </div>

        {!bundle ? (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 px-6 py-14 text-center dark:border-[#2A2A2A]">
            <Wallet className="h-8 w-8 text-slate-400" aria-hidden />
            <p className="mt-3 text-[14px] font-medium text-slate-800 dark:text-[#FAFAFA]">
              Your incentive plan for {label} hasn&apos;t been set up yet — contact your manager.
            </p>
          </div>
        ) : (
          <>
            {bundle.plan.status === 'closed' ? (
              <p className="mb-3 rounded-md bg-slate-100 px-3 py-2 text-[12px] text-slate-600 dark:bg-[#161616] dark:text-[#A1A1AA]">
                This plan is closed. Figures are read-only.
              </p>
            ) : null}
            <IncentiveCalculator
              terms={bundle.plan.terms}
              actuals={bundle.actuals}
              actualsSource={bundle.plan.actualsSource}
              fiscalLabel={bundle.plan.fiscalLabel}
              planId={bundle.plan.id}
              planClosed={bundle.plan.status === 'closed'}
              canEditActuals={canEnterManualActuals(
                { userId, role: membership.role },
                bundle.plan,
              )}
              enteredByName={bundle.actuals?.enteredBy === userId ? 'you' : bundle.actuals?.enteredBy ? 'your admin' : null}
              subject="self"
            />
          </>
        )}
      </main>
    );
  });
}
