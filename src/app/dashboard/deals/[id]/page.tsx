import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { aiFeaturesEnabled, getAIMode } from '@/lib/ai/config';
import { getCachedSummary } from '@/lib/ai/summary-queries';
import { withTenantSession } from '@/lib/auth-guard';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import type { CustomValues } from '@/lib/custom-fields/types';
import { getDealSummaryInsight } from '@/lib/intelligence/runner';

import { LiveDealSummaryCard } from '../../intelligence/_components/live-ai-card';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { formatCurrency } from '@/lib/deals/currency';
import { listContactOptions } from '@/lib/contacts/queries';
import { listDealContacts } from '@/lib/deals/contacts';
import { listDealDocuments } from '@/lib/deals/documents';
import { getDealById } from '@/lib/deals/queries';
import { getDealStageHistory } from '@/lib/deals/stage-history';
import { DEAL_STAGE_LABELS, DEAL_TYPE_LABELS } from '@/lib/deals/schema';
import { marginBpsToPct, marginMinor } from '@/lib/deals/approval';
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canApproveDeals, canAssignDeals, canManageDeals } from '@/lib/rbac';
import { listTasksForEntity } from '@/lib/tasks/queries';
import { listTeammates } from '@/lib/teammates/queries';
import { getEntityTimeline } from '@/lib/timeline/queries';

import { resolveAuthorLookup } from '../../_components/author-lookup';
import { CommentsThread } from '../../_components/comments-thread';
import { ComposeEmailLauncher } from '../../_components/compose-email-launcher';
import { EntityTasksPanel } from '../../_components/entity-tasks-panel';
import {
  DEAL_ACTIVITY_FILTERS,
  EntityTimeline,
} from '../../_components/entity-timeline';
import { LogActivityLauncher } from './_components/log-activity-launcher';
import { CustomFieldsDisplay } from '../../_components/custom-fields-display';
import { EntityViewers } from '../../_components/entity-viewers';
import { NotesTimeline } from '../../_components/notes-timeline';
import { RelationshipHealthCard } from '../../_components/relationship-health-card';
import { DealApprovalControls } from './_components/deal-approval-controls';
import { DealContactsCard } from './_components/deal-contacts-card';
import { DealDocumentsCard } from './_components/deal-documents-card';
import { DealFieldEditor } from './_components/deal-field-editor';
import { DealInlineHeader } from './_components/deal-inline-header';
import { DealOwnerPicker } from './_components/deal-owner-picker';
import { StageHistoryCard } from './_components/stage-history-card';
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
      stageHistory,
      dealContactRows,
      contactOptions,
      dealDocumentRows,
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
      getDealStageHistory(tenant.id, deal.id),
      listDealContacts(tenant.id, deal.id),
      listContactOptions(tenant.id),
      listDealDocuments(tenant.id, deal.id),
    ]);

    // Primary stakeholder's email is what the top "Email" button defaults to.
    const primaryContact = dealContactRows.find((c) => c.isPrimary) ?? null;
    const primaryEmail = primaryContact?.email ?? deal.contactEmail ?? null;
    // Proposal-stage-or-later deals with no stakeholders are a hygiene gap.
    const stageIsProposalOrLater = ['proposal', 'negotiation', 'hold', 'won'].includes(
      deal.stage,
    );

    const customValues = (deal.customFields ?? {}) as CustomValues;
    const hasCustom = customFieldDefs.some((d) => {
      const v = customValues[d.key];
      return v !== undefined && v !== null && v !== '';
    });

    const canEdit = canManageDeals(membership.role);
    // Assigning a deal owner is owner/manager only; a manager can't assign
    // to an owner, so they pick from the team minus owners.
    const canAssign = canAssignDeals(membership.role);
    const canApprove = canApproveDeals(membership.role);
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
    for (const d of dealDocumentRows) authorIds.add(d.uploadedBy);
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
            marginPct:
              deal.marginBps != null ? String(marginBpsToPct(deal.marginBps)) : '',
          }}
          initialLostReason={deal.lostReason}
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
            defaultRecipients={primaryEmail ? [primaryEmail] : []}
            canSend={canEdit}
          />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="flex flex-col gap-5">
            <RelationshipHealthCard
              tenantId={tenant.id}
              entityType="deal"
              entityId={deal.id}
            />

            <SidebarSection title="Deal Info">
              <DetailCard label="Stage" value={DEAL_STAGE_LABELS[deal.stage]} />
              {deal.dealType ? (
                <DetailCard
                  label="Deal type"
                  value={DEAL_TYPE_LABELS[deal.dealType]}
                />
              ) : null}
              <DetailCard
                label="Amount"
                value={formatCurrency(deal.amountMinor, deal.currency)}
                mono
              />
              {deal.unitPriceMinor != null && deal.quantity != null ? (
                <DetailCard
                  label="Unit price × Qty"
                  value={`${formatCurrency(deal.unitPriceMinor, deal.currency)} × ${deal.quantity}`}
                  mono
                />
              ) : null}
              {deal.marginBps != null ? (
                <DetailCard
                  label="Margin"
                  value={`${marginBpsToPct(deal.marginBps)}% · ${formatCurrency(
                    marginMinor(deal.amountMinor, deal.marginBps),
                    deal.currency,
                  )}`}
                  mono
                />
              ) : null}
              {deal.stage === 'won' ? (
                <DetailCard
                  label="Approval"
                  value={
                    deal.approvalStatus === 'approved'
                      ? 'Approved'
                      : deal.approvalStatus === 'pending'
                        ? 'Pending manager approval'
                        : deal.approvalStatus === 'rejected'
                          ? 'Rejected'
                          : '—'
                  }
                />
              ) : null}
              {canApprove &&
              deal.stage === 'won' &&
              deal.approvalStatus === 'pending' ? (
                <DealApprovalControls dealId={deal.id} />
              ) : null}
              <DetailCard
                label="Expected close"
                value={
                  deal.expectedCloseDate
                    ? dateFormatter.format(new Date(deal.expectedCloseDate))
                    : '—'
                }
              />
              <StageHistoryCard
                entries={stageHistory.entries.map((e) => ({
                  stage: e.stage,
                  durationDays: e.durationDays,
                  isCurrent: e.isCurrent,
                }))}
                currentDurationDays={stageHistory.currentDurationDays}
                staleReason={stageHistory.staleReason}
                avgForCurrent={
                  stageHistory.currentStage
                    ? stageHistory.avgByStage[stageHistory.currentStage] ?? null
                    : null
                }
              />
              {deal.stage === 'lost' && deal.lostReason ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
                    Lost reason
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm text-rose-900 dark:text-rose-100">
                    {deal.lostReason}
                  </div>
                </div>
              ) : null}
            </SidebarSection>

            <SidebarSection title="Relationship">
              <DetailCard label="Company" value={deal.companyName ?? '—'} />
              <DetailCard
                label="Contact"
                value={deal.contactName ?? deal.contactEmail ?? '—'}
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
              <DealContactsCard
                dealId={deal.id}
                initialContacts={dealContactRows}
                contactOptions={contactOptions}
                canEdit={canEdit}
                showEmptyWarning={stageIsProposalOrLater}
              />
            </SidebarSection>

            <SidebarSection title="Context">
              <DealFieldEditor
                dealId={deal.id}
                field="competitor"
                label="Competitor"
                initialValue={deal.competitor ?? null}
                canEdit={canEdit}
                placeholder="Who else is in this deal?"
              />
              <DealFieldEditor
                dealId={deal.id}
                field="source"
                label="Source"
                initialValue={deal.source ?? null}
                canEdit={canEdit}
                options={[
                  'Outbound',
                  'Referral',
                  'Inbound-Website',
                  'Partner',
                  'Other',
                ]}
              />
              <DealFieldEditor
                dealId={deal.id}
                field="nextStep"
                label="Next step"
                initialValue={deal.nextStep ?? null}
                canEdit={canEdit}
                multiline
                placeholder="What has to happen to close?"
              />
            </SidebarSection>

            <SidebarSection title="Record">
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
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Custom fields
                  </div>
                  <CustomFieldsDisplay
                    defs={customFieldDefs}
                    values={customValues}
                    className="grid grid-cols-1 gap-y-2"
                  />
                </div>
              ) : null}
            </SidebarSection>
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

            {/*
              AI deal analysis + AI summary are hidden entirely unless the
              workspace has AI features switched on (AI_FEATURES_ENABLED).
              We never show a visibly fake / "mock" generating state in front
              of a client — an unwired feature is absent, not pretend-live.
            */}
            {aiFeaturesEnabled() ? (
              <>
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
                  modeOverride={aiMode === 'disabled' ? 'disabled' : undefined}
                />

                <SummaryCard
                  dealId={deal.id}
                  initialSummary={cachedSummary?.summary ?? null}
                  initialGeneratedAt={cachedSummary?.generatedAt.toISOString() ?? null}
                />
              </>
            ) : null}

            <EntityTasksPanel
              entityType="deal"
              entityId={deal.id}
              ownerId={deal.ownerId}
              currentUserId={userId}
              initialTasks={tasks}
              canEdit={canEdit}
              teammates={teammates}
            />

            <EntityTimeline
              items={timeline}
              authorLookup={authorLookup}
              currentUserId={userId}
              title="Activity"
              filterModes={DEAL_ACTIVITY_FILTERS}
              emptyLabel="No activity logged yet. Log a call or meeting, or take an action on this deal."
              headerAction={
                canEdit ? (
                  // key silences React's list-child validation: this element is
                  // created here but rendered as a sibling of EntityTimeline's
                  // static header children.
                  <div key="log-activity" className="relative">
                    <LogActivityLauncher dealId={deal.id} />
                  </div>
                ) : null
              }
            />

            <DealDocumentsCard
              dealId={deal.id}
              initialDocuments={dealDocumentRows}
              authorLookup={authorLookup}
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
          </section>
        </div>
      </main>
    );
  });
}

/**
 * Groups related sidebar fields under a small-caps section header with a
 * subtle divider, so the left column reads as three scannable sections
 * (Deal Info / Relationship / Context) rather than one flat stack.
 */
function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-slate-200 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:border-[#1F1F1F] dark:text-[#71717A]">
        {title}
      </h2>
      {children}
    </section>
  );
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
      {/* Label: small, gray, uppercase. Value: larger, dark, medium — a clear
          type-hierarchy step so label and value never read as the same rank. */}
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1 text-[15px] font-medium text-slate-900 ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
