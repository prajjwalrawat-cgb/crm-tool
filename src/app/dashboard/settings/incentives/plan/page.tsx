import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import {
  getPlanRow,
  getPlanRowForUser,
  getTemplate,
  latestActualsForPlans,
  listVersions,
  toPlanView,
} from '@/lib/incentives/queries';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { can } from '@/lib/rbac';
import { fiscalYearLabel } from '@/lib/targets/fiscal';
import { listTeammates } from '@/lib/teammates/queries';

import { Panel } from '../../../incentives/_components/incentive-calculator';
import { VersionHistory } from '../../../incentives/_components/version-history';
import { PlanEditor } from '../_components/plan-editor';

export const metadata = { title: 'Incentive plan · Settings' };

/**
 * ?planId=…           edit an existing plan
 * ?userId=…&fy=2026   create one (redirects to edit if it already exists)
 */
export default async function IncentivePlanEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ planId?: string; userId?: string; fy?: string }>;
}) {
  await requirePersonas(['admin']);
  const sp = await searchParams;
  return await withTenantSession(async ({ tenant }) => {
    const membership = await requireMembership();
    if (!can(membership.role, 'manageIncentives')) redirect('/dashboard');
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const [teammates, template] = await Promise.all([listTeammates(tenant.id, tenant.name), getTemplate(tenant.id)]);
    const nameOf = new Map(teammates.map((t) => [t.id, t.displayName]));

    if (sp.planId) {
      if (!/^[0-9a-f-]{36}$/i.test(sp.planId)) notFound();
      const row = await getPlanRow(tenant.id, sp.planId);
      if (!row) notFound();
      const plan = toPlanView(row, startMonth);
      const [actuals, versions] = await Promise.all([
        latestActualsForPlans(tenant.id, [row]),
        listVersions(tenant.id, row.id),
      ]);
      const name = nameOf.get(plan.userId) ?? plan.userId;
      return (
        <main className="space-y-4">
          <BackLink fy={plan.fiscalYear} />
          <PlanEditor
            // Remount on a new version so the form starts from what was saved.
            key={plan.version}
            mode="edit"
            planId={plan.id}
            version={plan.version}
            status={plan.status}
            actualsSource={plan.actualsSource}
            initialTerms={plan.terms}
            templateTerms={template.terms}
            displayName={name}
            fiscalLabel={plan.fiscalLabel}
            actuals={actuals.get(plan.id) ?? null}
          />
          <Panel title="Plan history (audit)">
            <VersionHistory versions={versions} names={Object.fromEntries(nameOf)} />
          </Panel>
        </main>
      );
    }

    const fy = Number(sp.fy);
    if (!sp.userId || !Number.isInteger(fy)) notFound();
    const existing = await getPlanRowForUser(tenant.id, sp.userId, fy);
    if (existing) redirect(`/dashboard/settings/incentives/plan?planId=${existing.id}`);
    if (!nameOf.has(sp.userId)) notFound();

    return (
      <main className="space-y-4">
        <BackLink fy={fy} />
        <PlanEditor
          mode="create"
          userId={sp.userId}
          fiscalYear={fy}
          initialTerms={template.terms}
          displayName={nameOf.get(sp.userId)!}
          fiscalLabel={fiscalYearLabel(startMonth, fy)}
          actuals={null}
        />
      </main>
    );
  });
}

function BackLink({ fy }: { fy: number }) {
  return (
    <Link href={`/dashboard/settings/incentives?fy=${fy}`} className="text-[12px] text-slate-500 hover:text-indigo-600 dark:text-[#A1A1AA]">
      ← All plans
    </Link>
  );
}
