import { withTenantSession } from '@/lib/auth-guard';
import { parseDealFilters } from '@/lib/deals/filters';
import { listDealCompanyOptions, listDealsForBoard } from '@/lib/deals/queries';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';

import { DealViewTabs } from '../_components/deal-view-tabs';
import { BoardView } from './_components/board-view';

export const metadata = {
  title: 'Deal board',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DealsBoardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;
    const sp = await searchParams;
    const filters = parseDealFilters(sp);
    const [summary, companyOptions, teammates, settings] = await Promise.all([
      listDealsForBoard(tenant.id, {
        restrictToOwnerOrUnassigned,
        filters,
        currentUserId: userId,
      }),
      listDealCompanyOptions(tenant.id),
      listTeammates(tenant.id, tenant.name),
      getOrgSettings(tenant.id),
    ]);

    const stageProbabilities = resolveStageProbabilities(
      settings.stageProbabilities,
    );

    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Pipeline</h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {tenant.name} — drag deals across stages.
            </p>
          </div>
          <DealViewTabs />
        </header>

        <BoardView
          initialBoard={summary.board}
          stageCounts={summary.counts}
          stageAmounts={summary.amounts}
          stageSlipped={summary.slipped}
          stageProbabilities={stageProbabilities}
          boardCurrency={settings.defaultCurrency}
          currentRole={membership.role}
          tenantId={tenant.id}
          initialFilters={filters}
          companyOptions={companyOptions}
          teammates={teammates}
          currentUserId={userId}
        />
      </main>
    );
  });
}
