import { withTenantSession } from '@/lib/auth-guard';
import { listDeletedCompanies } from '@/lib/companies/queries';
import { listDeletedContacts } from '@/lib/contacts/queries';
import { listDeletedDeals } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';

import { RecentlyDeletedView } from './_components/recently-deleted-view';

export const metadata = {
  title: 'Recently deleted',
};

export default async function RecentlyDeletedPage() {
  return await withTenantSession(async ({ tenant }) => {
    // Recently-deleted views read up to one cursor page each (default
    // 50 rows per entity type). At our retention windows the table
    // rarely accumulates more than that — if it does, the user can
    // restore in batches and re-open the page. Skipping pagination
    // controls here to keep the screen scannable.
    const [membership, companiesPage, contactsPage, dealsPage] = await Promise.all([
      requireMembership(),
      listDeletedCompanies(tenant.id),
      listDeletedContacts(tenant.id),
      listDeletedDeals(tenant.id),
    ]);
    const companies = companiesPage.items;
    const contacts = contactsPage.items;
    const deals = dealsPage.items;

    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              Recently deleted
            </h1>
            <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              your role: {membership.role}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Soft-deleted records still in this tenant. Owners and admins can
            restore. Permanent delete is owner-only.
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
  });
}
