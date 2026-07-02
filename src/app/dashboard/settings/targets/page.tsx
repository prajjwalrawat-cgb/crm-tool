import { withTenantSession } from '@/lib/auth-guard';
import { fromMinorUnits } from '@/lib/deals/currency';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { requirePersonas } from '@/lib/personas/guards';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { listTargets } from '@/lib/targets/queries';
import { listTeammates } from '@/lib/teammates/queries';

import { TargetsManager } from './_components/targets-manager';

export const metadata = { title: 'Targets · Settings' };

export default async function TargetsSettingsPage({
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
    const choices = fiscalYearChoices(startMonth, now);
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy)
        ? parsedFy
        : currentFiscalYear(startMonth, now);

    const [teammates, targets] = await Promise.all([
      listTeammates(tenant.id, tenant.name),
      listTargets(tenant.id, fiscalYear),
    ]);

    // Managers + sales reps carry targets; owners/admins set them.
    const members = teammates
      .filter((t) => personaOf(t.role) !== 'admin')
      .map((t) => ({ id: t.id, displayName: t.displayName, role: t.role }));

    const targetByUser = new Map(targets.map((t) => [t.userId, t]));
    const initial = members.map((m) => {
      const t = targetByUser.get(m.id);
      return {
        userId: m.id,
        displayName: m.displayName,
        role: m.role,
        revenue: t ? fromMinorUnits(t.revenueTargetMinor, t.currency).toString() : '',
        margin: t ? fromMinorUnits(t.marginTargetMinor, t.currency).toString() : '',
      };
    });

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Sales targets
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Set each team member&apos;s annual Revenue and Margin targets. Progress
            is measured against Won deals after manager approval. Amounts are in{' '}
            {settings.defaultCurrency}.
          </p>
        </header>
        <TargetsManager
          fiscalYear={fiscalYear}
          fiscalYearLabel={fiscalYearLabel(startMonth, fiscalYear)}
          choices={choices.map((y) => ({
            value: y,
            label: fiscalYearLabel(startMonth, y),
          }))}
          currency={settings.defaultCurrency}
          rows={initial}
        />
      </main>
    );
  });
}
