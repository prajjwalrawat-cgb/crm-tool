import { listCompanyOptions } from '@/lib/companies/queries';
import { listContactOptions } from '@/lib/contacts/queries';
import { listDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

import { DealsView } from './_components/deals-view';

export const metadata = {
  title: 'Deals',
};

type SearchParams = Promise<{ q?: string }>;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [tenant, membership] = await Promise.all([
    requireTenant(),
    requireMembership(),
  ]);
  const { q } = await searchParams;
  const search = q?.trim() || undefined;

  const [items, companyOptions, contactOptions] = await Promise.all([
    listDeals(tenant.id, { search }),
    listCompanyOptions(tenant.id),
    listContactOptions(tenant.id),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {tenant.name}
        </p>
      </header>

      <DealsView
        initialItems={items}
        initialSearch={search ?? ''}
        companyOptions={companyOptions}
        contactOptions={contactOptions}
        currentRole={membership.role}
      />
    </main>
  );
}
