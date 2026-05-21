import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptions } from '@/lib/companies/queries';
import { parseContactFilters } from '@/lib/contacts/filters';
import { listContacts } from '@/lib/contacts/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';

import { ContactsView } from './_components/contacts-view';

export const metadata = {
  title: 'Contacts',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ContactsPage({
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
    const filters = parseContactFilters(sp);

    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;

    const [page, companyOptions, teammates] = await Promise.all([
      listContacts(tenant.id, {
        search,
        cursor,
        size,
        filters,
        currentUserId: userId,
        restrictToOwnerOrUnassigned,
      }),
      listCompanyOptions(tenant.id),
      listTeammates(tenant.id, tenant.name),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Contacts</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name}
          </p>
        </header>

        <ContactsView
          initialItems={page.items}
          initialSearch={search ?? ''}
          companyOptions={companyOptions}
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
