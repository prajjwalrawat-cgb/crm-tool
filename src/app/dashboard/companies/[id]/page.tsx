import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { getAccount360 } from '@/lib/companies/account-360';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import type { CustomValues } from '@/lib/custom-fields/types';
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canManageCompanies } from '@/lib/rbac';
import { listTasksForEntity } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';

import { CommentsThread } from '../../_components/comments-thread';
import { ComposeEmailLauncher } from '../../_components/compose-email-launcher';
import { EntityOwnerCard } from '../../_components/entity-owner-card';
import { EntityTasksPanel } from '../../_components/entity-tasks-panel';
import { CustomFieldsDisplay } from '../../_components/custom-fields-display';
import { EntityTimeline } from '../../_components/entity-timeline';
import { NotesTimeline } from '../../_components/notes-timeline';
import { resolveAuthorLookup } from '../../_components/author-lookup';
import { updateCompanyOwnerAction } from '../actions';

import { AccountContactsCard } from './_components/account-contacts-card';
import { AccountDealsCard } from './_components/account-deals-card';
import { EditableCompanyCard } from './_components/editable-company-card';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// The view is "Account 360"; the entity this product ships is a
// Company, and the breadcrumb, sidebar and list view all say so. The
// tab title follows the product's vocabulary, not the feature's.
export const metadata = {
  title: 'Company',
};

type Params = Promise<{ id: string }>;

/**
 * Account 360 — one page that answers "what is going on with this
 * account" without a tour of three list views.
 *
 * Three columns, matching the deal detail page's conventions:
 *
 *   left    the account record itself, inline-editable in place
 *   center  every task, every conversation, and an activity feed that
 *           spans the account AND everything under it
 *   right   contact and deal rollups, each linking to the existing list
 *           view pre-filtered to this account
 *
 * The rollups and the account-wide feed come from ONE aggregate read
 * (`getAccount360`) rather than four; the same function backs
 * `GET /api/companies/:id/360` for non-React callers.
 *
 * No Cases panel: this product has no Cases-equivalent module, and an
 * empty card for a table that does not exist is worse than no card.
 *
 * Field mapping, since the CRM's Company columns are the account's
 * fields under different names: `domain` is the website and `industry`
 * is the account type. There is no `description` or parent-account
 * column, so neither is rendered — stubbing a field the record cannot
 * store would show every account as permanently blank.
 */
export default async function AccountDetailPage({
  params,
}: {
  params: Params;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;

    // Resolves the account and 404s before anything else is fetched, so
    // an id from another tenant never reaches the panels below.
    const account = await getAccount360(tenant.id, id);
    if (!account) notFound();
    const company = account.company;

    const [membership, notes, comments, tasks, teammates, customFieldDefs] =
      await Promise.all([
        requireMembership(),
        listNotesForEntity(tenant.id, 'company', company.id, { limit: 100 }),
        listCommentsForEntity(tenant.id, 'company', company.id, {
          limit: 200,
        }),
        listTasksForEntity(tenant.id, 'company', company.id, { limit: 50 }),
        listTeammates(tenant.id, tenant.name),
        listCustomFieldDefs(tenant.id, 'company'),
      ]);

    const canEdit = canManageCompanies(membership.role);
    const customValues = (company.customFields ?? {}) as CustomValues;
    const hasCustom = customFieldDefs.some((d) => {
      const v = customValues[d.key];
      return v !== undefined && v !== null && v !== '';
    });

    // One batched name lookup for every actor on the page.
    const authorIds = new Set<string>();
    for (const n of notes) authorIds.add(n.authorUserId);
    for (const c of comments) {
      authorIds.add(c.authorUserId);
      for (const m of c.mentionedUserIds) authorIds.add(m);
    }
    for (const t of account.timeline) {
      const actor =
        t.kind === 'note' || t.kind === 'comment'
          ? t.row.authorUserId
          : t.row.actorUserId;
      if (actor) authorIds.add(actor);
    }
    if (company.ownerId) authorIds.add(company.ownerId);
    const authorLookup = await resolveAuthorLookup(Array.from(authorIds));

    const websiteHref = company.domain
      ? company.domain.startsWith('http')
        ? company.domain
        : `https://${company.domain}`
      : null;

    // One fragment, two slots: the right rail at xl, folded under the
    // account panel below it. Defined once so the two never drift.
    const rollups = (
      <>
        <AccountContactsCard
          companyId={company.id}
          rows={account.contacts.rows}
          total={account.contacts.total}
        />
        <AccountDealsCard
          companyName={company.name}
          rows={account.deals.rows}
          total={account.deals.total}
        />
      </>
    );

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/companies"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All companies
        </Link>

        <header className="mt-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {company.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {company.industry ?? 'Company'}
              {company.domain ? (
                <>
                  {' · '}
                  <span className="font-mono text-slate-600">
                    {company.domain}
                  </span>
                </>
              ) : null}
              {' · '}
              <span className="tabular-nums">
                {account.deals.total} {account.deals.total === 1 ? 'deal' : 'deals'}
              </span>
              {' · '}
              <span className="tabular-nums">
                {account.contacts.total}{' '}
                {account.contacts.total === 1 ? 'contact' : 'contacts'}
              </span>
            </p>
          </div>
          <ComposeEmailLauncher
            entityType="company"
            entityId={company.id}
            entityLabel={company.name}
            canSend={canEdit}
          />
        </header>

        <div className="mt-6 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          {/* LEFT — the account record, editable in place. */}
          <aside className="flex flex-col gap-3">
            <EditableCompanyCard
              companyId={company.id}
              label="Name"
              display={company.name}
              field={{ key: 'name', value: company.name }}
              canEdit={canEdit}
            />
            <div className="flex flex-col gap-1">
              <EditableCompanyCard
                companyId={company.id}
                label="Website"
                display={company.domain ?? '—'}
                mono
                field={{
                  key: 'domain',
                  value: company.domain ?? '',
                  placeholder: 'acme.com',
                  nullWhenEmpty: true,
                }}
                canEdit={canEdit}
              />
              {websiteHref ? (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 self-start rounded px-1 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50 hover:text-indigo-700"
                >
                  Open site
                  <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                </a>
              ) : null}
            </div>
            <EditableCompanyCard
              companyId={company.id}
              label="Type"
              display={company.industry ?? '—'}
              field={{
                key: 'industry',
                value: company.industry ?? '',
                placeholder: 'Manufacturing',
                nullWhenEmpty: true,
              }}
              canEdit={canEdit}
            />
            <EntityOwnerCard
              entityId={company.id}
              currentOwnerId={company.ownerId}
              currentOwnerName={
                company.ownerId ? authorLookup[company.ownerId] ?? null : null
              }
              currentUserId={userId}
              teammates={teammates}
              canEdit={canEdit}
              onSave={updateCompanyOwnerAction}
            />
            <EditableCompanyCard
              companyId={company.id}
              label="Created"
              display={dateFormatter.format(new Date(company.createdAt))}
              canEdit={false}
            />
            <EditableCompanyCard
              companyId={company.id}
              label="Updated"
              display={dateFormatter.format(new Date(company.updatedAt))}
              canEdit={false}
            />
            {hasCustom ? (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
                  Custom fields
                </div>
                <CustomFieldsDisplay
                  defs={customFieldDefs}
                  values={customValues}
                  className="grid grid-cols-1 gap-y-2"
                />
              </div>
            ) : null}

            {/* Below xl the right rail folds under the account panel
                rather than squeezing the timeline to an unreadable width. */}
            <div className="flex flex-col gap-3 xl:hidden">{rollups}</div>
          </aside>

          {/* CENTER — what is happening, across the whole account. */}
          <section className="space-y-4">
            <EntityTasksPanel
              entityType="company"
              entityId={company.id}
              ownerId={company.ownerId}
              currentUserId={userId}
              initialTasks={tasks}
              canEdit={canEdit}
              teammates={teammates}
            />

            <EntityTimeline
              title="Account activity"
              items={account.timeline}
              authorLookup={authorLookup}
              currentUserId={userId}
              groupByMonth
              showSource
              emptyLabel="Nothing has happened on this account, its deals, or its contacts yet."
            />

            <CommentsThread
              tenantId={tenant.id}
              entityType="company"
              entityId={company.id}
              currentUserId={userId}
              initialComments={comments}
              authorLookup={authorLookup}
              teammates={teammates}
              canWrite={canEdit}
            />

            <NotesTimeline
              entityType="company"
              entityId={company.id}
              currentUserId={userId}
              initialNotes={notes}
              authorLookup={authorLookup}
              canWrite={canEdit}
            />
          </section>

          {/* RIGHT — rollups, each a door into the filtered list view. */}
          <aside className="hidden flex-col gap-3 xl:flex">{rollups}</aside>
        </div>
      </main>
    );
  });
}
