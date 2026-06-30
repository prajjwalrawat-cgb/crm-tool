import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getAIMode } from '@/lib/ai/config';
import { getCachedSummary } from '@/lib/ai/summary-queries';
import { withTenantSession } from '@/lib/auth-guard';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import type { CustomValues } from '@/lib/custom-fields/types';
import { getDealSummaryInsight } from '@/lib/intelligence/runner';

import { LiveDealSummaryCard } from '../../intelligence/_components/live-ai-card';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { formatCurrency } from '@/lib/deals/currency';
import { getDealById } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canAssignDeals, canManageDeals } from '@/lib/rbac';
import { listTasksForEntity } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';
import { getEntityTimeline } from '@/lib/timeline/queries';

import { resolveAuthorLookup } from '../../_components/author-lookup';
import { CommentsThread } from '../../_components/comments-thread';
import { ComposeEmailLauncher } from '../../_components/compose-email-launcher';
import { EntityTasksPanel } from '../../_components/entity-tasks-panel';
import { EntityTimeline } from '../../_components/entity-timeline';
import { CustomFieldsDisplay } from '../../_components/custom-fields-display';
import { EntityViewers } from '../../_components/entity-viewers';
import { NotesTimeline } from '../../_components/notes-timeline';
import { RelationshipHealthCard } from '../../_components/relationship-health-card';
import { StageBadge } from '../_components/stage-badge';
import { DealInlineHeader } from './_components/deal-inline-header';
import { DealOwnerPicker } from './_components/deal-owner-picker';
import { SummaryCard } from './_components/summary-card';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const metadata = {
  title: 'Deal',
};

type Params = Promise<{ id: string }>;

export default async function DealDetailPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;

    const deal = await getDealById(tenant.id, id);
    if (!deal) notFound();

    const aiMode = getAIMode();
    const [
      membership,
      cachedSummary,
      notes,
      comments,
      tasks,
      teammates,
      timeline,
      dealInsight,
      customFieldDefs,
    ] = await Promise.all([
      requireMembership(),
      getCachedSummary(tenant.id, 'deal', deal.id),
      listNotesForEntity(tenant.id, 'deal', deal.id, { limit: 100 }),
      listCommentsForEntity(tenant.id, 'deal', deal.id, { limit: 200 }),
      listTasksForEntity(tenant.id, 'deal', deal.id, { limit: 50 }),
      listTeammates(tenant.id, tenant.name),
      getEntityTimeline(tenant.id, 'deal', deal.id, { limit: 150 }),
      getDealSummaryInsight(tenant.id, userId, deal.id),
      listCustomFieldDefs(tenant.id, 'deal'),
    ]);

    const customValues = (deal.customFields ?? {}) as CustomValues;
    const hasCustom = customFieldDefs.some((d) => {
      const v = customValues[d.key];
      return v !== undefined && v !== null && v !== '';
    });

    const canEdit = canManageDeals(membership.role);
    // Assigning a deal owner is owner/manager only; a manager can't assign
    // to an owner, so they pick from the team minus owners.
    const canAssign = canAssignDeals(membership.role);
    const assignableTeammates =
      membership.role === 'owner'
        ? teammates
        : teammates.filter((t) => t.role !== 'owner');

    // Resolve author display names across notes, comments, timeline
    // activity, and the deal owner. One Clerk batch lookup serves
    // everything.
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
    if (deal.ownerId) authorIds.add(deal.ownerId);
    if (deal.updatedBy) authorIds.add(deal.updatedBy);
    const authorLookup = await resolveAuthorLookup(Array.from(authorIds));

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/deals"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All deals
        </Link>

        <DealInlineHeader
          initial={{
            name: deal.name,
            stage: deal.stage,
            amountMajor: (deal.amountMinor / 100).toFixed(2),
            currency: deal.currency,
            expectedCloseDate: deal.expectedCloseDate ?? null,
          }}
          dealId={deal.id}
          companyId={deal.companyId ?? null}
          contactId={deal.contactId ?? null}
          canEdit={canEdit}
          tenantId={tenant.id}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <EntityViewers
            tenantId={tenant.id}
            currentUserId={userId}
            entityType="deal"
            entityId={deal.id}
          />
          <ComposeEmailLauncher
            entityType="deal"
            entityId={deal.id}
            entityLabel={deal.name}
            defaultRecipients={
              deal.contactEmail ? [deal.contactEmail] : []
            }
            canSend={canEdit}
          />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="flex flex-col gap-3">
            <RelationshipHealthCard
              tenantId={tenant.id}
              entityType="deal"
              entityId={deal.id}
            />
            <DetailCard label="Stage" value={DEAL_STAGE_LABELS[deal.stage]} />
            <DetailCard
              label="Amount"
              value={formatCurrency(deal.amountMinor, deal.currency)}
              mono
            />
            <DetailCard
              label="Expected close"
              value={
                deal.expectedCloseDate
                  ? dateFormatter.format(new Date(deal.expectedCloseDate))
                  : '—'
              }
            />
            <DealOwnerPicker
              dealId={deal.id}
              currentOwnerId={deal.ownerId}
              currentOwnerName={
                deal.ownerId ? authorLookup[deal.ownerId] ?? null : null
              }
              currentUserId={userId}
              teammates={assignableTeammates}
              canEdit={canAssign}
            />
            <DetailCard label="Company" value={deal.companyName ?? '—'} />
            <DetailCard
              label="Contact"
              value={deal.contactName ?? deal.contactEmail ?? '—'}
            />
            <DetailCard
              label="Created"
              value={dateFormatter.format(new Date(deal.createdAt))}
            />
            <DetailCard
              label="Last updated"
              value={
                (deal.updatedBy
                  ? `${authorLookup[deal.updatedBy] ?? 'Someone'} · `
                  : '') + dateFormatter.format(new Date(deal.updatedAt))
              }
            />
            {deal.closedAt ? (
              <DetailCard
                label="Closed"
                value={dateFormatter.format(new Date(deal.closedAt))}
              />
            ) : null}
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
          </aside>

          <section className="space-y-4">
            {deal.description ? (
              <article className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Description
                </h2>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                  {deal.description}
                </p>
              </article>
            ) : null}

            <LiveDealSummaryCard
              tenantId={tenant.id}
              dealId={deal.id}
              title="AI deal analysis"
              subtitle="Structured signal — risks and next actions from your activity log"
              tone="info"
              summaryId={null}
              hideFeedback
              initial={dealInsight.content}
              initialState={dealInsight.state}
              initialGeneratedAt={dealInsight.generatedAt?.toISOString() ?? null}
              modeOverride={
                aiMode === 'disabled'
                  ? 'disabled'
                  : aiMode === 'mock'
                    ? 'mock'
                    : undefined
              }
            />

            <SummaryCard
              dealId={deal.id}
              initialSummary={cachedSummary?.summary ?? null}
              initialGeneratedAt={cachedSummary?.generatedAt.toISOString() ?? null}
              aiMode={aiMode}
            />

            <EntityTasksPanel
              entityType="deal"
              entityId={deal.id}
              ownerId={deal.ownerId}
              currentUserId={userId}
              initialTasks={tasks}
              canEdit={canEdit}
            />

            <CommentsThread
              tenantId={tenant.id}
              entityType="deal"
              entityId={deal.id}
              currentUserId={userId}
              initialComments={comments}
              authorLookup={authorLookup}
              teammates={teammates}
              canWrite={canEdit}
            />

            <NotesTimeline
              entityType="deal"
              entityId={deal.id}
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
