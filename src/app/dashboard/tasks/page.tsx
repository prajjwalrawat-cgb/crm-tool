import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptions } from '@/lib/companies/queries';
import { listContactOptions } from '@/lib/contacts/queries';
import { listDealOptions } from '@/lib/deals/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { parseTaskFilters } from '@/lib/tasks/filters';
import { listTasks } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';

import { TasksView } from './_components/tasks-view';

export const metadata = {
  title: 'Tasks',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TasksPage({
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
    const filters = parseTaskFilters(sp);

    const [
      membership,
      page,
      companyOptions,
      contactOptions,
      dealOptions,
      teammates,
    ] = await Promise.all([
      requireMembership(),
      listTasks(tenant.id, {
        search,
        cursor,
        size,
        filters,
        currentUserId: userId,
      }),
      listCompanyOptions(tenant.id),
      listContactOptions(tenant.id),
      listDealOptions(tenant.id),
      listTeammates(tenant.id, tenant.name),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Tasks
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500">{tenant.name}</p>
        </header>

        <TasksView
          initialItems={page.items}
          initialSearch={search ?? ''}
          initialFilters={filters}
          currentUserId={userId}
          currentRole={membership.role}
          companyOptions={companyOptions}
          contactOptions={contactOptions}
          dealOptions={dealOptions}
          teammates={teammates}
          nextCursor={page.nextCursor}
          pageSize={page.size}
        />
      </main>
    );
  });
}
