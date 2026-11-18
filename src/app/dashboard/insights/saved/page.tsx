import { can } from '@/lib/rbac';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { listSavedReportsFor, peopleById, repsInScope } from '@/lib/reports/manager/services';

import { PageHeader } from '../_components/page-header';
import { SavedReports } from '../_components/saved-reports';

/** Saved report definitions + digest schedules (yours, and ones you receive). */
export default async function SavedPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const me = ctx.scope.viewerUserId;
    const [reports, ids] = await Promise.all([
      listSavedReportsFor(ctx.tenant.id, me),
      repsInScope(ctx.scope),
    ]);
    const people = await peopleById([...new Set([me, ...ids])]);
    return (
      <>
        <PageHeader ctx={ctx} title="Saved reports" description="Save a set of metrics and get it by email." showRange={false} />
        <SavedReports
          reports={reports}
          people={[...people.values()].map((p) => ({ id: p.id, name: p.name }))}
          me={me}
          canScheduleForOthers={can(ctx.membership.role, 'inviteMembers')}
        />
      </>
    );
  });
}
