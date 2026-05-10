import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptions } from '@/lib/companies/queries';
import { listContacts } from '@/lib/contacts/queries';
import { requireMembership } from '@/lib/membership';

import { ContactsView } from './_components/contacts-view';

export const metadata = {
  title: 'Contacts',
};

type SearchParams = Promise<{ q?: string }>;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant }) => {
    const { q } = await searchParams;
    const search = q?.trim() || undefined;

    const [membership, items, companyOptions] = await Promise.all([
      requireMembership(),
      listContacts(tenant.id, { search }),
      listCompanyOptions(tenant.id),
    ]);

    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {tenant.name}
          </p>
        </header>

        <ContactsView
          initialItems={items}
          initialSearch={search ?? ''}
          companyOptions={companyOptions}
          currentRole={membership.role}
        />
      </main>
    );
  });
}
