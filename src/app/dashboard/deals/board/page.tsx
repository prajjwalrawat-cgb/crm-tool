import { withTenantSession } from '@/lib/auth-guard';
import { listDealsForBoard } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';

import { DealViewTabs } from '../_components/deal-view-tabs';
import { BoardView } from './_components/board-view';

export const metadata = {
  title: 'Deal board',
};

export default async function DealsBoardPage() {
  return await withTenantSession(async ({ tenant }) => {
    const [membership, summary] = await Promise.all([
      requireMembership(),
      listDealsForBoard(tenant.id),
    ]);

    const cappedNotice = summary.capped
      ? 'Showing the 50 most recent per stage; switch to the list view for the full pipeline.'
      : null;

    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {tenant.name} — drag deals across stages.
            </p>
            {cappedNotice ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
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
