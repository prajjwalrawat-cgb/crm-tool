import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { listOfferingOptions } from '@/lib/offerings/queries';
import {
  getProspect,
  listProspectsForBoard,
  listProspectStageHistory,
  listSourceTags,
} from '@/lib/prospects/queries';
import { parseProspectFilters } from '@/lib/prospects/rules';
import { listTeammates } from '@/lib/teammates/queries';

import { ProspectBoard } from './_components/prospect-board';

export const metadata = {
  title: 'Prospect board',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProspectsPage({ searchParams }: { searchParams: SearchParams }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const sp = await searchParams;
    const filters = parseProspectFilters(sp);
    const p = Array.isArray(sp.p) ? sp.p[0] : sp.p;
    const [cards, sourceTags, teammates, offerings, openProspect, openHistory] = await Promise.all([
      listProspectsForBoard(tenant.id, userId, filters),
      listSourceTags(tenant.id),
      listTeammates(tenant.id, tenant.name),
      listOfferingOptions(tenant.id, { activeOnly: true }),
      p ? getProspect(tenant.id, p) : Promise.resolve(null),
      p ? listProspectStageHistory(tenant.id, p) : Promise.resolve([]),
    ]);

    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Prospect board</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name} — research prospects and drag them across stages.
          </p>
        </header>

        <ProspectBoard
          cards={cards}
          filters={filters}
          sourceTags={sourceTags}
          teammates={teammates}
          offerings={offerings.map((o) => ({ id: o.id, name: o.name }))}
          role={membership.role}
          currentUserId={userId}
          openProspect={openProspect}
          openHistory={openHistory}
        />
      </main>
    );
  });
}
