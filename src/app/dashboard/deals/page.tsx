import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptions } from '@/lib/companies/queries';
import { listContactOptions } from '@/lib/contacts/queries';
import { parseDealFilters } from '@/lib/deals/filters';
import { listDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';

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

    const [membership, page, companyOptions, contactOptions] = await Promise.all([
      requireMembership(),
      listDeals(tenant.id, {
        search,
        cursor,
        size,
        filters,
        currentUserId: userId,
      }),
      listCompanyOptions(tenant.id),
      listContactOptions(tenant.id),
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
          currentRole={membership.role}
          nextCursor={page.nextCursor}
          pageSize={page.size}
        />
      </main>
    );
  });
}
