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
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
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
