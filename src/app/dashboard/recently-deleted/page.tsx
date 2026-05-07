import { listDeletedCompanies } from '@/lib/companies/queries';
import { listDeletedContacts } from '@/lib/contacts/queries';
import { listDeletedDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

import { RecentlyDeletedView } from './_components/recently-deleted-view';

export const metadata = {
  title: 'Recently deleted',
};

export default async function RecentlyDeletedPage() {
  const [tenant, membership] = await Promise.all([
    requireTenant(),
    requireMembership(),
  ]);

  const [companies, contacts, deals] = await Promise.all([
    listDeletedCompanies(tenant.id),
    listDeletedContacts(tenant.id),
    listDeletedDeals(tenant.id),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Recently deleted
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Soft-deleted records still in this tenant. Owners can restore.
        </p>
      </header>

      <RecentlyDeletedView
        companies={companies}
        contacts={contacts}
        deals={deals}
        currentRole={membership.role}
      />
    </main>
  );
}
