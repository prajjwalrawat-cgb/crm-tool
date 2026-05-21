import { withTenantSession } from '@/lib/auth-guard';
import { listDealsForBoard } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

import { DealViewTabs } from '../_components/deal-view-tabs';
import { BoardView } from './_components/board-view';

export const metadata = {
  title: 'Deal board',
};

export default async function DealsBoardPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;
    const summary = await listDealsForBoard(tenant.id, {
      restrictToOwnerOrUnassigned,
    });

    const cappedNotice = summary.capped
      ? 'Showing the 50 most recent per stage; switch to the list view for the full pipeline.'
      : null;

    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Pipeline</h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {tenant.name} — drag deals across stages.
            </p>
            {cappedNotice ? (
              <p className="mt-1 text-xs text-amber-700">
                {cappedNotice}
              </p>
            ) : null}
          </div>
          <DealViewTabs />
        </header>

        <BoardView
          initialBoard={summary.board}
          stageCounts={summary.counts}
          currentRole={membership.role}
          tenantId={tenant.id}
        />
      </main>
    );
  });
}
