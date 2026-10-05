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
import { formatCurrency, KNOWN_CURRENCIES } from '@/lib/deals/currency';
import { listCompanyOptionsScoped } from '@/lib/companies/queries';
import {
  listContactOptions,
  listContactPickerOptions,
} from '@/lib/contacts/queries';
import { listDealContacts } from '@/lib/deals/contacts';
import { listDealDocuments } from '@/lib/deals/documents';
import { getDealById } from '@/lib/deals/queries';
import { getCollectionSettings, getDealCreditTerms } from '@/lib/collections/queries';
import { getDealStageHistory } from '@/lib/deals/stage-history';
import { getDealScoreWithHistory } from '@/lib/deals/scoring/service';
import { getDealRisk } from '@/lib/deals/risk/queries';
import {
  isOfferingsEnabled,
  listDealOfferings,
  listOfferingOptions,
} from '@/lib/offerings/queries';
import { listDealValueSplit } from '@/lib/deals/value-split-queries';
import { getPathBarGates } from '@/lib/stage-gates/evaluate';
import { PATH_STAGES } from '@/lib/stage-gates/types';
import { DEAL_TYPE_LABELS, DEAL_TYPES } from '@/lib/deals/schema';
import { marginBpsToPct, marginMinor } from '@/lib/deals/approval';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';
import { listNotesForEntity } from '@/lib/notes/queries';
import {
  can,
  canApproveDeals,
  canAssignDeals,
  canManageDeals,
  canManageForecast,
  canManageOfferings,
} from '@/lib/rbac';
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
import { DealCloseDateCard } from './_components/deal-close-date-card';
import { DealContactsCard } from './_components/deal-contacts-card';
import { DealCreditTermsCard } from './_components/deal-credit-terms-card';
import { DealOfferingsCard } from './_components/deal-offerings-card';
import { OfferingsDisabledNotice } from '../_components/offerings-disabled-notice';
import { DealDocumentsCard } from './_components/deal-documents-card';
import { DealFieldEditor } from './_components/deal-field-editor';
import { DealInlineHeader } from './_components/deal-inline-header';
import { DealStageCard } from './_components/deal-stage-card';
import { DealValueSplitCard } from './_components/deal-value-split-card';
import { EditableDetailCard } from './_components/editable-detail-card';
import { DealOwnerPicker } from './_components/deal-owner-picker';
import { StageHistoryCard } from './_components/stage-history-card';
import { DealAuditCard } from './_components/deal-audit-card';
import { SummaryCard } from './_components/summary-card';
import { DealPathBar } from './_components/deal-path-bar';
import { DealRiskCard } from './_components/deal-risk-card';
import { DealScoreCard } from './_components/deal-score-card';
import { ForecastCategorySelect } from './_components/forecast-category-select';
import { HoldControl } from './_components/hold-control';

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
    // Picker scope for Company / Contact, same as the deals list: sales see
    // records they own or unassigned. Chained off the (cached) membership
    // read so the option loads still run inside the parallel batch below.
    const membershipPromise = requireMembership();
    const pickerScopePromise = membershipPromise.then((m) =>
      personaOf(m.role) === 'sales' ? userId : undefined,
    );
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
      pathBarGates,
      dealScore,
      valueSplitRows,
      dealRisk,
      offeringsEnabled,
      dealOfferingRows,
      offeringOptions,
      companyPickerOptions,
      contactPickerOptions,
      creditTerms,
      collectionSettings,
    ] = await Promise.all([
      membershipPromise,
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
      // Path bar: live gate state for the forward funnel + current stage.
      getPathBarGates(
        tenant.id,
        deal.id,
        Array.from(new Set([...PATH_STAGES, deal.stage])),
      ),
      // Deal Score card: current score + trend history (Module 2).
      getDealScoreWithHistory(tenant.id, deal.id),
      // Multi-year TCV breakdown (empty for single-year deals).
      listDealValueSplit(tenant.id, deal.id),
      // Phase 1 risk score. A stored read — the nightly job writes it, this
      // page never computes it and never calls a model.
      getDealRisk(tenant.id, deal.id),
      // Offerings (0067): a per-workspace switch. The two reads below run
      // regardless — they're cheap, and gating them would mean awaiting the
      // flag before the whole parallel batch — but the card only renders
      // when the switch is on.
      isOfferingsEnabled(tenant.id),
      // Tags ON this deal: the full catalog, retired entries included — a
      // retired offering must keep rendering where it already is.
      listDealOfferings(tenant.id, deal.id),
      // The ADD picker: active entries only.
      listOfferingOptions(tenant.id),
      // Company / Contact pickers in the Relationship section.
      pickerScopePromise.then((scope) => listCompanyOptionsScoped(tenant.id, scope)),
      pickerScopePromise.then((scope) => listContactPickerOptions(tenant.id, scope)),
      // Credit terms (0069) and the standard they're measured against.
      getDealCreditTerms(tenant.id, deal.id),
      getCollectionSettings(tenant.id),
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
    const canForecast = canManageForecast(membership.role);
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

    // A deal carrying unit price + qty derives its Amount from that pair, so
    // Amount is never edited directly for it.
    const amountDerived =
      deal.unitPriceMinor != null && deal.quantity != null;

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/deals"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All deals
        </Link>

        {/* Amount is computed for unit-priced deals: the Amount card is
            read-only there and the Unit price × Qty card drives it. */}
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
          dealId={deal.id}
          canEdit={canEdit}
          tenantId={tenant.id}
        />

        {pathBarGates.enabled ? (
          <DealPathBar currentStage={deal.stage} byStage={pathBarGates.byStage} />
        ) : null}

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
              {/* Every card below edits in place and patches only its own
                  columns — see editable-detail-card.tsx. */}
              <DealStageCard
                dealId={deal.id}
                dealName={deal.name}
                stage={deal.stage}
                expectedCloseDate={deal.expectedCloseDate ?? null}
                canEdit={canEdit}
              />
              <EditableDetailCard
                dealId={deal.id}
                label="Deal type"
                display={deal.dealType ? DEAL_TYPE_LABELS[deal.dealType] : '—'}
                canEdit={canEdit}
                fields={[
                  {
                    key: 'dealType',
                    type: 'select',
                    value: deal.dealType ?? '',
                    whenEmpty: 'null',
                    options: [
                      { value: '', label: '—' },
                      ...DEAL_TYPES.map((t) => ({
                        value: t,
                        label: DEAL_TYPE_LABELS[t],
                      })),
                    ],
                  },
                ]}
              />
              <EditableDetailCard
                dealId={deal.id}
                label="Amount"
                display={formatCurrency(deal.amountMinor, deal.currency)}
                mono
                canEdit={canEdit && !amountDerived}
                hint={
                  amountDerived
                    ? 'Computed from Unit price × Qty'
                    : undefined
                }
                fields={
                  amountDerived
                    ? undefined
                    : [
                        {
                          key: 'amount',
                          type: 'number',
                          step: '0.01',
                          min: '0',
                          value: (deal.amountMinor / 100).toFixed(2),
                          whenEmpty: 'zero',
                          widthClass: 'w-32',
                        },
                        {
                          key: 'currency',
                          type: 'select',
                          value: deal.currency,
                          options: KNOWN_CURRENCIES.map((c) => ({
                            value: c,
                            label: c,
                          })),
                          widthClass: 'w-24',
                        },
                      ]
                }
              />
              {amountDerived ? (
                <EditableDetailCard
                  dealId={deal.id}
                  label="Unit price × Qty"
                  display={`${formatCurrency(deal.unitPriceMinor!, deal.currency)} × ${deal.quantity}`}
                  mono
                  canEdit={canEdit}
                  hint="Amount follows this pair"
                  fields={[
                    {
                      key: 'unitPrice',
                      label: 'Unit price',
                      type: 'number',
                      step: '0.01',
                      min: '0',
                      value: (deal.unitPriceMinor! / 100).toFixed(2),
                      whenEmpty: 'zero',
                      widthClass: 'w-28',
                    },
                    {
                      key: 'quantity',
                      label: 'Qty',
                      type: 'number',
                      step: '1',
                      min: '0',
                      value: String(deal.quantity),
                      whenEmpty: 'zero',
                      widthClass: 'w-20',
                    },
                  ]}
                />
              ) : null}
              <EditableDetailCard
                dealId={deal.id}
                label="Margin"
                display={
                  deal.marginBps != null
                    ? `${marginBpsToPct(deal.marginBps)}% · ${formatCurrency(
                        marginMinor(deal.amountMinor, deal.marginBps),
                        deal.currency,
                      )}`
                    : '—'
                }
                mono
                canEdit={canEdit}
                fields={[
                  {
                    key: 'marginPct',
                    type: 'number',
                    step: '0.01',
                    min: '0',
                    placeholder: 'e.g. 30',
                    value:
                      deal.marginBps != null
                        ? String(marginBpsToPct(deal.marginBps))
                        : '',
                    widthClass: 'w-24',
                  },
                ]}
              />
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
              {/* Close date has its own card rather than a generic editable
                  one: it carries the pushback summary, the skippable "why is
                  this pushed back?" prompt on a forward move, and the date
                  history timeline. */}
              <DealCloseDateCard
                dealId={deal.id}
                expectedCloseDate={deal.expectedCloseDate ?? null}
                originalCloseDate={deal.originalCloseDate ?? null}
                pushCount={deal.pushCount}
                totalSlipDays={deal.totalSlipDays}
                stage={deal.stage}
                canEdit={canEdit}
              />
              <DealCreditTermsCard
                dealId={deal.id}
                standardDays={collectionSettings.standardCreditDays}
                terms={
                  creditTerms
                    ? {
                        days: creditTerms.agreedCreditDays,
                        note: creditTerms.note,
                        setByName: creditTerms.setBy
                          ? (teammates.find((t) => t.id === creditTerms.setBy)?.displayName ?? creditTerms.setBy)
                          : null,
                        approvedByName: creditTerms.approvedBy
                          ? (teammates.find((t) => t.id === creditTerms.approvedBy)?.displayName ?? creditTerms.approvedBy)
                          : null,
                        approvedAt: creditTerms.approvedAt ? creditTerms.approvedAt.toISOString() : null,
                      }
                    : null
                }
                canEdit={canEdit}
                canApprove={can(membership.role, 'approveCreditTerms')}
              />
              <ForecastCategorySelect
                dealId={deal.id}
                current={deal.forecastCategory ?? null}
                overridden={deal.forecastCategoryOverridden}
                canEdit={canForecast}
              />
              <HoldControl
                dealId={deal.id}
                dealName={deal.name}
                stage={deal.stage}
                holdReason={deal.holdReason ?? null}
                holdRevisitOn={deal.holdRevisitOn ?? null}
                holdNote={deal.holdNote ?? null}
                canEdit={canEdit}
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
              {/* R5 — the unified who-changed-what for stage, close date and
                  amount. Collapsed and fetched on expand; sits next to Stage
                  history, which answers the different question of how long
                  the deal spent in each stage. */}
              <DealAuditCard dealId={deal.id} />
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
              {/* Changing the company clears the contact (contacts are
                  company-scoped), same as the inline edit on the deals list. */}
              <EditableDetailCard
                dealId={deal.id}
                label="Company"
                display={deal.companyName ?? '—'}
                canEdit={canEdit}
                extraPayload={{ contactId: null }}
                fields={[
                  {
                    key: 'companyId',
                    type: 'select',
                    value: deal.companyId ?? '',
                    whenEmpty: 'null',
                    options: withCurrent(
                      [
                        { value: '', label: '— No company —' },
                        ...companyPickerOptions.map((c) => ({
                          value: c.id,
                          label: c.name,
                        })),
                      ],
                      deal.companyId,
                      deal.companyName,
                    ),
                  },
                ]}
              />
              <EditableDetailCard
                dealId={deal.id}
                label="Contact"
                display={deal.contactName ?? deal.contactEmail ?? '—'}
                canEdit={canEdit}
                fields={[
                  {
                    key: 'contactId',
                    type: 'select',
                    value: deal.contactId ?? '',
                    whenEmpty: 'null',
                    options: withCurrent(
                      [
                        { value: '', label: '— No contact —' },
                        // Within the deal's company; a deal with no company
                        // can take any contact (an individual customer).
                        ...contactPickerOptions
                          .filter(
                            (c) => !deal.companyId || c.companyId === deal.companyId,
                          )
                          .map((c) => ({ value: c.id, label: c.label })),
                      ],
                      deal.contactId,
                      deal.contactName ?? deal.contactEmail,
                    ),
                  },
                ]}
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
              {/* What this deal is selling (0066). Sits in Relationship
                  rather than beside Stage: it answers "what is this", the
                  same question as Company and Contact, not "where is it". */}
              {offeringsEnabled ? (
                <DealOfferingsCard
                  dealId={deal.id}
                  initialOfferings={dealOfferingRows}
                  offeringOptions={offeringOptions}
                  canEdit={canEdit}
                />
              ) : (
                <OfferingsDisabledNotice
                  tags={dealOfferingRows}
                  canTurnOn={canManageOfferings(membership.role)}
                  compact
                />
              )}
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
              Right-column order (highest-usage first): Activity → Tasks → AI →
              Documents. Activity is a rep's most-used widget, so it leads;
              the AI cards sit below the day-to-day widgets.
            */}
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

            {/* Risk sits directly under Health on purpose: a reader who has
                just seen "82 healthy" needs "31 risk" in the same glance, and
                each card states its own direction. */}
            {dealRisk ? <DealRiskCard risk={dealRisk} /> : null}

            {dealScore.current ? (
              <DealScoreCard
                score={dealScore.current.score}
                band={dealScore.current.band}
                reasons={dealScore.current.reasons}
                history={dealScore.history.map((p) => ({
                  score: p.score,
                  computedAt: p.computedAt.toISOString(),
                }))}
              />
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

            {/* Multi-year TCV. Record-and-report only: the deal still counts
                once, at its full amount, everywhere else. */}
            <DealValueSplitCard
              dealId={deal.id}
              amountMinor={deal.amountMinor}
              currency={deal.currency}
              expectedCloseDate={deal.expectedCloseDate ?? null}
              initialRows={valueSplitRows}
              canEdit={canEdit}
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
/**
 * Picker options plus the deal's current link when role scope hid it (a
 * sales rep viewing a deal linked to someone else's record), so the select
 * opens on the real value instead of silently showing the first option.
 */
function withCurrent(
  options: Array<{ value: string; label: string }>,
  currentId: string | null,
  currentLabel: string | null,
): Array<{ value: string; label: string }> {
  if (!currentId || options.some((o) => o.value === currentId)) return options;
  return [...options, { value: currentId, label: currentLabel ?? '(current)' }];
}

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
