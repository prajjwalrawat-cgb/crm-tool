import { withTenantSession } from '@/lib/auth-guard';
import { listCompanies } from '@/lib/companies/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';

import { CompaniesView } from './_components/companies-view';

export const metadata = {
  title: 'Companies',
};

type SearchParams = Promise<{
  q?: string;
  cursor?: string;
  size?: string;
}>;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const search = sp.q?.trim() || undefined;
    const cursor = parseCursorParam(sp.cursor);
    const size = parsePageSize(sp.size);

    const [membership, page] = await Promise.all([
      requireMembership(),
      listCompanies(tenant.id, { search, cursor, size }),
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
          currentRole={membership.role}
          nextCursor={page.nextCursor}
          pageSize={page.size}
        />
      </main>
    );
  });
}
