import { withTenantSession } from '@/lib/auth-guard';
import { listCompanies } from '@/lib/companies/queries';
import { requireMembership } from '@/lib/membership';

import { CompaniesView } from './_components/companies-view';

export const metadata = {
  title: 'Companies',
};

type SearchParams = Promise<{ q?: string }>;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant }) => {
    const { q } = await searchParams;
    const search = q?.trim() || undefined;

    const [membership, items] = await Promise.all([
      requireMembership(),
      listCompanies(tenant.id, { search }),
    ]);

    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {tenant.name}
          </p>
        </header>

        <CompaniesView
          initialItems={items}
          initialSearch={search ?? ''}
          currentRole={membership.role}
        />
      </main>
    );
  });
}
