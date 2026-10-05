import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { getTemplate } from '@/lib/incentives/queries';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { listTeammates } from '@/lib/teammates/queries';

import { FiscalYearSelect } from '../../../targets/_components/fy-select';
import { BulkChange } from '../_components/bulk-change';

export const metadata = { title: 'Bulk incentive change · Settings' };

export default async function BulkIncentiveChangePage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    // The next FY is the usual target of a rate change, so it is selectable.
    const choices = fiscalYearChoices(startMonth, now, { forward: 1 });
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy) ? parsedFy : currentFiscalYear(startMonth, now);
    const [template, teammates] = await Promise.all([getTemplate(tenant.id), listTeammates(tenant.id, tenant.name)]);

    return (
      <main className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href={`/dashboard/settings/incentives?fy=${fiscalYear}`} className="text-[12px] text-slate-500 hover:text-indigo-600 dark:text-[#A1A1AA]">
            ← All plans
          </Link>
          <FiscalYearSelect value={fiscalYear} choices={choices.map((y) => ({ value: y, label: fiscalYearLabel(startMonth, y) }))} />
        </div>
        <BulkChange
          key={fiscalYear}
          fiscalYear={fiscalYear}
          fiscalLabel={fiscalYearLabel(startMonth, fiscalYear)}
          template={template.terms}
          names={Object.fromEntries(teammates.map((t) => [t.id, t.displayName]))}
        />
      </main>
    );
  });
}
