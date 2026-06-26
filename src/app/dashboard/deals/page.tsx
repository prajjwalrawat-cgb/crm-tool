import { withTenantSession } from '@/lib/auth-guard';
import { listContactOptions } from '@/lib/contacts/queries';
import { parseDealFilters } from '@/lib/deals/filters';
import { listDealCompanyOptions, listDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';

import { DealsView } from './_components/deals-view';
import { DealViewTabs } from './_components/deal-view-tabs';

export const metadata = {
  title: 'Deals',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const sp = await searchParams;
    const search = typeof sp.q === 'string' ? sp.q.trim() || undefined : undefined;
    const cursor = parseCursorParam(typeof sp.cursor === 'string' ? sp.cursor : undefined);
    const size = parsePageSize(typeof sp.size === 'string' ? sp.size : undefined);
    const filters = parseDealFilters(sp);
    // Resolve persona BEFORE the parallel fetch so we can clamp the
    // deals query to "mine or unassigned" for sales personas. The
    // restriction is server-enforced — URL params can narrow further
    // (by stage/amount) but cannot widen scope.
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;

    const [page, companyOptions, contactOptions, teammates] =
      await Promise.all([
        listDeals(tenant.id, {
          search,
          cursor,
          size,
          filters,
          currentUserId: userId,
          restrictToOwnerOrUnassigned,
        }),
        listDealCompanyOptions(tenant.id),
        listContactOptions(tenant.id),
        listTeammates(tenant.id, tenant.name),
      ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Deals</h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {tenant.name}
            </p>
          </div>
          <DealViewTabs />
        </header>

        <DealsView
          initialItems={page.items}
          initialSearch={search ?? ''}
          initialFilters={filters}
          companyOptions={companyOptions}
          contactOptions={contactOptions}
          teammates={teammates}
          currentUserId={userId}
          currentRole={membership.role}
          nextCursor={page.nextCursor}
          pageSize={page.size}
        />
      </main>
    );
  });
}
