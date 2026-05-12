import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { getCompanyById } from '@/lib/companies/queries';
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canManageCompanies } from '@/lib/rbac';
import { listTasksForEntity } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';
import { getEntityTimeline } from '@/lib/timeline/queries';

import { CommentsThread } from '../../_components/comments-thread';
import { EntityOwnerCard } from '../../_components/entity-owner-card';
import { EntityTasksPanel } from '../../_components/entity-tasks-panel';
import { EntityTimeline } from '../../_components/entity-timeline';
import { NotesTimeline } from '../../_components/notes-timeline';
import { resolveAuthorLookup } from '../../_components/author-lookup';
import { updateCompanyOwnerAction } from '../actions';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const metadata = {
  title: 'Company',
};

type Params = Promise<{ id: string }>;

export default async function CompanyDetailPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;
    const company = await getCompanyById(tenant.id, id);
    if (!company) notFound();

    const [membership, notes, comments, tasks, teammates, timeline] =
      await Promise.all([
        requireMembership(),
        listNotesForEntity(tenant.id, 'company', company.id, { limit: 100 }),
        listCommentsForEntity(tenant.id, 'company', company.id, { limit: 200 }),
        listTasksForEntity(tenant.id, 'company', company.id, { limit: 50 }),
        listTeammates(tenant.id, tenant.name),
        getEntityTimeline(tenant.id, 'company', company.id, { limit: 150 }),
      ]);

    const canEdit = canManageCompanies(membership.role);

    const authorIds = new Set<string>();
    for (const n of notes) authorIds.add(n.authorUserId);
    for (const c of comments) {
      authorIds.add(c.authorUserId);
      for (const m of c.mentionedUserIds) authorIds.add(m);
    }
    for (const t of timeline) {
      if (t.kind === 'activity' && t.row.actorUserId) {
        authorIds.add(t.row.actorUserId);
      }
    }
    if (company.ownerId) authorIds.add(company.ownerId);
    const authorLookup = await resolveAuthorLookup(Array.from(authorIds));

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
            </p>
          </div>
        </header>

        <div className="mt-6 grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="flex flex-col gap-3">
            <DetailCard label="Industry" value={company.industry ?? '—'} />
            <DetailCard label="Domain" value={company.domain ?? '—'} mono />
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
            <DetailCard
              label="Created"
              value={dateFormatter.format(new Date(company.createdAt))}
            />
            <DetailCard
              label="Updated"
              value={dateFormatter.format(new Date(company.updatedAt))}
            />
          </aside>

          <section className="space-y-4">
            <EntityTasksPanel
              entityType="company"
              entityId={company.id}
              ownerId={company.ownerId}
              currentUserId={userId}
              initialTasks={tasks}
              canEdit={canEdit}
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

            <EntityTimeline
              items={timeline}
              authorLookup={authorLookup}
              currentUserId={userId}
            />
          </section>
        </div>
      </main>
    );
  });
}

function DetailCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
