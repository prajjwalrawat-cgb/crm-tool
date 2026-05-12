import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptions } from '@/lib/companies/queries';
import { listContactOptions } from '@/lib/contacts/queries';
import { listDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';

import { DealsView } from './_components/deals-view';
import { DealViewTabs } from './_components/deal-view-tabs';

export const metadata = {
  title: 'Deals',
};

type SearchParams = Promise<{
  q?: string;
  cursor?: string;
  size?: string;
}>;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const search = sp.q?.trim() || undefined;
    const cursor = parseCursorParam(sp.cursor);
    const size = parsePageSize(sp.size);

    const [membership, page, companyOptions, contactOptions] = await Promise.all([
      requireMembership(),
      listDeals(tenant.id, { search, cursor, size }),
      listCompanyOptions(tenant.id),
      listContactOptions(tenant.id),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
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
