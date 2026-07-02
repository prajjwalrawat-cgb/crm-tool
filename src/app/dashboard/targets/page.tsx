import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { getTargetProgress } from '@/lib/targets/queries';

import { FiscalYearSelect } from './_components/fy-select';
import { TargetProgressList } from './_components/target-progress-list';

export const metadata = { title: 'Targets' };

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
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

    // Admins/managers see the whole team; a sales rep sees only their own.
    const onlyUserId = persona === 'sales' ? userId : undefined;
    const rows = await getTargetProgress(
      tenant.id,
      tenant.name,
      fiscalYear,
      startMonth,
      { onlyUserId },
    );

    const ctx = {
      defaultCurrency: settings.defaultCurrency,
      currencyLocale: settings.currencyLocale,
      compactNumbers: settings.compactNumbers,
    };

    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Sales targets
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Achievement counts Won deals after manager approval ·{' '}
              {fiscalYearLabel(startMonth, fiscalYear)}
            </p>
          </div>
          <FiscalYearSelect
            value={fiscalYear}
            choices={choices.map((y) => ({
              value: y,
              label: fiscalYearLabel(startMonth, y),
            }))}
          />
        </div>

        <div className="mt-5">
          <TargetProgressList rows={rows} ctx={ctx} />
        </div>
      </main>
    );
  });
}
