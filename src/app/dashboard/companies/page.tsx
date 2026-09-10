import { withTenantSession } from '@/lib/auth-guard';
import {
  parseCompanyFilters,
  parseCompanySort,
} from '@/lib/companies/filters';
import { listCompanies } from '@/lib/companies/queries';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';

import { CompaniesView } from './_components/companies-view';

export const metadata = {
  title: 'Companies',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CompaniesPage({
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
    const filters = parseCompanyFilters(sp);
    const { sort, dir } = parseCompanySort(sp);

    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;

    const [page, teammates, customFieldDefs, settings] = await Promise.all([
      listCompanies(tenant.id, {
        search,
        cursor,
        size,
        filters,
        sort,
        dir,
        currentUserId: userId,
        restrictToOwnerOrUnassigned,
      }),
      listTeammates(tenant.id, tenant.name),
      listCustomFieldDefs(tenant.id, 'company'),
      getOrgSettings(tenant.id),
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
          teammates={teammates}
          currentUserId={userId}
          currentRole={membership.role}
          nextCursor={page.nextCursor}
          pageSize={page.size}
          customFieldDefs={customFieldDefs}
          sort={sort}
          dir={dir}
          // Money in the rollup columns is a sum of minor units across
          // whatever currencies the account's deals carry, rendered in the
          // tenant's currency + locale. Passing the context down (rather
          // than formatting here) keeps the numbers formatted identically
          // on the server pass and after hydration.
          currencyContext={{
            defaultCurrency: settings.defaultCurrency,
            currencyLocale: settings.currencyLocale,
            compactNumbers: settings.compactNumbers,
          }}
        />
      </main>
    );
  });
}
