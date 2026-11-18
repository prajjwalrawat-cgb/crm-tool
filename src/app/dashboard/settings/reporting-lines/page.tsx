import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { can } from '@/lib/rbac';
import { listBackfillJobs } from '@/lib/reports/manager/rollup';
import { peopleById } from '@/lib/reports/manager/services';
import { listTeamMembers } from '@/lib/team/queries';

import { ReportingLinesForm } from './_components/reporting-lines-form';

export const metadata = { title: 'Reporting lines · Settings' };

/**
 * Settings > Reporting lines. Who reports to whom decides what a manager
 * sees in Sales reports (themselves + everyone below them).
 */
export default async function ReportingLinesPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const me = await requireMembership();
    const [members, settings, jobs] = await Promise.all([listTeamMembers(tenant.id), getOrgSettings(tenant.id), listBackfillJobs(tenant.id)]);
    const people = await peopleById(members.map((m) => m.userId));
    const rows = members
      .filter((m) => m.status === 'active')
      .map((m) => ({
        userId: m.userId,
        name: people.get(m.userId)?.name ?? ([m.firstName, m.lastName].filter(Boolean).join(' ') || m.userId),
        email: m.email,
        role: m.role,
        reportsTo: m.reportsToUserId ?? null,
      }));
    const last = jobs.at(-1);
    return (
      <ReportingLinesForm
        canEdit={can(me.role, 'manageMembers')}
        members={rows}
        narrativeEnabled={settings.reportNarrativeEnabled}
        timezone={settings.timezone}
        backfill={last ? { status: last.status, daysDone: last.daysDone, daysTotal: last.daysTotal, fromDay: last.fromDay, toDay: last.toDay } : null}
      />
    );
  });
}
