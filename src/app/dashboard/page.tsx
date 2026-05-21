import { currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
} from '@/lib/currency/format';
import { ensureMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';

import { SalesHome } from './_components/home/sales-home';

export const metadata = {
  title: 'Home',
};

/**
 * Persona-branching Home (Phase 17-A).
 *
 *   sales   → SalesHome (revenue funnel hero + today's actions +
 *             my pipeline + communication priority)
 *   manager → /dashboard/executive (existing team command center)
 *   admin   → /dashboard/command-center (existing operations overview)
 *
 * For manager/admin we 307-redirect rather than render a near-
 * duplicate of those pages. Phase 17-B can build dedicated
 * manager/admin Home compositions if the existing pages drift.
 *
 * One canonical /dashboard URL keeps bookmarks stable; the routing
 * decision happens server-side so there's no client-side flicker.
 */
export default async function DashboardHome() {
  const membership = await ensureMembership();
  const persona = personaOf(membership?.role ?? null);

  if (persona === 'manager') redirect('/dashboard/executive');
  if (persona === 'admin') redirect('/dashboard/command-center');

  // persona === 'sales' → render the workflow-first sales home.
  return await withTenantSession(async ({ tenant, userId }) => {
    const [user, settings, pipeline] = await Promise.all([
      currentUser(),
      getOrgSettings(tenant.id),
      pipelineByStageRunner(
        tenant.id,
        { range: 'last_90d', owner: { type: 'mine' } },
        { currentUserId: userId },
      ),
    ]);

    const money = (minor: number) =>
      settings.compactNumbers
        ? formatCompactTenantCurrency(minor, settings)
        : formatTenantCurrency(minor, settings);

    return (
      <SalesHome
        user={{
          firstName: user?.firstName ?? null,
        }}
        tenantName={tenant.name}
        pipelineRows={pipeline.rows}
        tenantId={tenant.id}
        currentUserId={userId}
        money={money}
      />
    );
  });
}
