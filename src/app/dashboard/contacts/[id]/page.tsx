import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { getContactById } from '@/lib/contacts/queries';
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canManageContacts } from '@/lib/rbac';
import { listTasksForEntity } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';
import { getEntityTimeline } from '@/lib/timeline/queries';

import { resolveAuthorLookup } from '../../_components/author-lookup';
import { CommentsThread } from '../../_components/comments-thread';
import { EntityTasksPanel } from '../../_components/entity-tasks-panel';
import { EntityTimeline } from '../../_components/entity-timeline';
import { NotesTimeline } from '../../_components/notes-timeline';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const metadata = {
  title: 'Contact',
};

type Params = Promise<{ id: string }>;

export default async function ContactDetailPage({
  params,
}: {
  params: Params;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;
    const contact = await getContactById(tenant.id, id);
    if (!contact) notFound();

    const [membership, notes, comments, tasks, teammates, timeline] =
      await Promise.all([
        requireMembership(),
        listNotesForEntity(tenant.id, 'contact', contact.id, { limit: 100 }),
        listCommentsForEntity(tenant.id, 'contact', contact.id, { limit: 200 }),
        listTasksForEntity(tenant.id, 'contact', contact.id, { limit: 50 }),
        listTeammates(tenant.id, tenant.name),
        getEntityTimeline(tenant.id, 'contact', contact.id, { limit: 150 }),
      ]);

    const canEdit = canManageContacts(membership.role);

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
    const authorLookup = await resolveAuthorLookup(Array.from(authorIds));

    const displayName =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
      contact.email ||
      '(unnamed)';

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/contacts"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All contacts
        </Link>

        <header className="mt-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {displayName}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {contact.title ?? 'Contact'}
              {contact.email ? (
                <>
                  {' · '}
                  <span className="font-mono text-slate-600">
                    {contact.email}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </header>

        <div className="mt-6 grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="flex flex-col gap-3">
            <DetailCard label="Title" value={contact.title ?? '—'} />
            <DetailCard label="Email" value={contact.email ?? '—'} mono />
            <DetailCard label="Phone" value={contact.phone ?? '—'} mono />
            <DetailCard
              label="Created"
              value={dateFormatter.format(new Date(contact.createdAt))}
            />
          </aside>

          <section className="space-y-4">
            <EntityTasksPanel
              entityType="contact"
              entityId={contact.id}
              ownerId={null}
              currentUserId={userId}
              initialTasks={tasks}
              canEdit={canEdit}
            />

            <CommentsThread
              tenantId={tenant.id}
              entityType="contact"
              entityId={contact.id}
              currentUserId={userId}
              initialComments={comments}
              authorLookup={authorLookup}
              teammates={teammates}
              canWrite={canEdit}
            />

            <NotesTimeline
              entityType="contact"
              entityId={contact.id}
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
