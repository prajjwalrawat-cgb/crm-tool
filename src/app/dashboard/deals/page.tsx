import { withTenantSession } from '@/lib/auth-guard';
import { listCompanyOptionsScoped } from '@/lib/companies/queries';
import { listContactPickerOptions } from '@/lib/contacts/queries';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import { parseDealFilters, withoutOfferingFilters } from '@/lib/deals/filters';
import { listDealCompanyOptions, listDeals } from '@/lib/deals/queries';
import {
  isOfferingsEnabled,
  listOfferingOptions,
} from '@/lib/offerings/queries';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requireMembership } from '@/lib/membership';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { personaOf } from '@/lib/personas';
import { listTeammates } from '@/lib/teammates/queries';

import { DealsView } from './_components/deals-view';
import { DealViewTabs } from './_components/deal-view-tabs';

export const metadata = {
  title: 'Deals',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DealsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const sp = await searchParams;
    const search = typeof sp.q === 'string' ? sp.q.trim() || undefined : undefined;
    const cursor = parseCursorParam(typeof sp.cursor === 'string' ? sp.cursor : undefined);
    const size = parsePageSize(typeof sp.size === 'string' ? sp.size : undefined);
    // Offerings is a per-workspace switch (0067). Read it BEFORE the fetch:
    // when it's off, the offering filters are stripped server-side so a stale
    // bookmark can't narrow the list invisibly.
    const offeringsEnabled = await isOfferingsEnabled(tenant.id);
    const parsedFilters = parseDealFilters(sp);
    const filters = offeringsEnabled
      ? parsedFilters
      : withoutOfferingFilters(parsedFilters);
    // `?sort=risk` orders by the nightly risk score instead of recency. It is
    // a distinct keyset mode, not a client-side re-sort of the page.
    const sort = sp.sort === 'risk' ? 'risk' : 'recent';
    // Resolve persona BEFORE the parallel fetch so we can clamp the
    // deals query to "mine or unassigned" for sales personas. The
    // restriction is server-enforced — URL params can narrow further
    // (by stage/amount) but cannot widen scope.
    const membership = await requireMembership();
    const persona = personaOf(membership.role);
    const restrictToOwnerOrUnassigned =
      persona === 'sales' ? userId : undefined;

    const [
      page,
      companyOptions,
      formCompanyOptions,
      formContactOptions,
      teammates,
      customFieldDefs,
      orgSettings,
      offeringOptions,
    ] = await Promise.all([
      listDeals(tenant.id, {
        search,
        sort,
        cursor,
        size,
        filters,
        currentUserId: userId,
        restrictToOwnerOrUnassigned,
      }),
      // Filter dropdown uses free-text company names; the form uses real,
      // role-scoped company/contact records.
      listDealCompanyOptions(tenant.id),
      listCompanyOptionsScoped(tenant.id, restrictToOwnerOrUnassigned),
      listContactPickerOptions(tenant.id, restrictToOwnerOrUnassigned),
      listTeammates(tenant.id, tenant.name),
      listCustomFieldDefs(tenant.id, 'deal'),
      getOrgSettings(tenant.id),
      // ACTIVE only: the create form must not be able to tag a new deal with
      // a retired offering. The deal detail page loads the full catalog for
      // display, since a retired tag still has to render where it already is.
      offeringsEnabled ? listOfferingOptions(tenant.id) : Promise.resolve([]),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Deals</h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {tenant.name}
            </p>
          </div>
          <DealViewTabs />
        </header>

        <DealsView
          initialItems={page.items}
          initialSearch={search ?? ''}
          sort={sort}
          initialFilters={filters}
          companyOptions={companyOptions}
          formCompanyOptions={formCompanyOptions}
          formContactOptions={formContactOptions}
          teammates={teammates}
          currentUserId={userId}
          currentRole={membership.role}
          nextCursor={page.nextCursor}
          pageSize={page.size}
          customFieldDefs={customFieldDefs}
          unitPricingEnabled={orgSettings.dealUnitPricingEnabled}
          offeringOptions={offeringOptions}
          offeringsEnabled={offeringsEnabled}
        />
      </main>
    );
  });
}
