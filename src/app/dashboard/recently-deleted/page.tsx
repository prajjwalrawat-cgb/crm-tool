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
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Recently deleted
            </h1>
            <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              your role: {membership.role}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-slate-500">
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
