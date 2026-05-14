import { withTenantSession } from '@/lib/auth-guard';
import { parseCompanyFilters } from '@/lib/companies/filters';
import { listCompanies } from '@/lib/companies/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { listTeammates } from '@/lib/teammates/queries';

import { CompaniesView } from './_components/companies-view';

export const metadata = {
  title: 'Companies',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const sp = await searchParams;
    const search =
      typeof sp.q === 'string' ? sp.q.trim() || undefined : undefined;
    const cursor = parseCursorParam(
      typeof sp.cursor === 'string' ? sp.cursor : undefined,
    );
    const size = parsePageSize(
      typeof sp.size === 'string' ? sp.size : undefined,
    );
    const filters = parseCompanyFilters(sp);

    const [membership, page, teammates] = await Promise.all([
      requireMembership(),
      listCompanies(tenant.id, {
        search,
        cursor,
        size,
        filters,
        currentUserId: userId,
      }),
      listTeammates(tenant.id, tenant.name),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Companies</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name}
          </p>
        </header>

        <CompaniesView
          initialItems={page.items}
          initialSearch={search ?? ''}
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
