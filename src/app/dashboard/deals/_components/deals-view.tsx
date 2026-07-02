'use client';

import { ChevronDown, ExternalLink, Loader2, Pencil, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactPickerOption } from '@/lib/contacts/queries';
import type { CustomFieldDef } from '@/lib/custom-fields/types';
import type { Teammate } from '@/lib/teammates/queries';
import { marginPctToBps } from '@/lib/deals/approval';
import { formatCurrency, fromMinorUnits, toMinorUnits } from '@/lib/deals/currency';
import type { DealFilters } from '@/lib/deals/filters';
import type { DealRow } from '@/lib/deals/queries';
import type { PageSize } from '@/lib/pagination/page-size';
import {
  type DealStage,
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
} from '@/lib/deals/schema';
import { canApproveDeals, canDeleteDeals, canManageDeals } from '@/lib/rbac';
import { cn } from '@/lib/utils';

import { CreateDrawer } from '../../_components/create-drawer';
import { FilterChips, type FilterChip } from '../../_components/filter-chips';
import { PaginationControls } from '../../_components/pagination-controls';
import {
  createDealAction,
  patchDealAction,
  softDeleteDealAction,
  updateDealAction,
  updateDealOwnerAction,
  updateDealStageAction,
} from '../actions';
import { TeammatePicker } from '../../_components/teammate-picker';
import { BulkUploadButton } from './bulk-upload-button';
import { CreateDealForm } from './create-deal-form';
import { DealFilterBar } from './deal-filter-bar';
import { EditDealDrawer } from './edit-deal-drawer';
import { EmptyState } from './empty-state';
import { InlineEditCell } from '../../_components/inline-edit-cell';
import { InlineSelectCell } from '../../_components/inline-select-cell';
import { SavedViews } from './saved-views';
import { StageBadge } from './stage-badge';

type DealItem = DealRow & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: DealItem }
  | { type: 'update'; draft: DealItem }
  | { type: 'patch'; id: string; patch: Partial<DealItem> }
  | { type: 'remove'; id: string };

/**
 * Fields editable inline in the table. Company/Contact are linked records now
 * (edited via the form's dropdowns); stage/owner have dedicated controls.
 */
type EditableField = 'amount' | 'expectedCloseDate';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function isDealStage(value: string): value is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(value);
}

export function DealsView({
  initialItems,
  initialSearch,
  initialFilters,
  companyOptions,
  formCompanyOptions,
  formContactOptions,
  teammates,
  currentUserId,
  currentRole,
  nextCursor,
  pageSize,
  customFieldDefs,
  unitPricingEnabled,
}: {
  initialItems: DealRow[];
  initialSearch: string;
  initialFilters: DealFilters;
  /** Free-text company names for the filter dropdown. */
  companyOptions: CompanyOption[];
  /** Real, role-scoped company/contact records for the create/edit forms. */
  formCompanyOptions: CompanyOption[];
  formContactOptions: ContactPickerOption[];
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
  customFieldDefs: CustomFieldDef[];
  unitPricingEnabled: boolean;
}) {
  const router = useRouter();
  const canEdit = canManageDeals(currentRole);
  const canDelete = canDeleteDeals(currentRole);
  // Inline owner reassignment: owner + manager only; a manager may not assign
  // to an owner, so they get the team minus owners.
  const canAssign = currentRole === 'owner' || currentRole === 'manager';
  const assignable =
    currentRole === 'owner'
      ? teammates
      : teammates.filter((t) => t.role !== 'owner');
  const filterChips = buildDealFilterChips(initialFilters, {
    companyOptions,
    teammates,
    currentUserId,
  });

  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();
  const [editPending, startEditTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();

  const [optimisticItems, applyOptimistic] = useOptimistic<DealItem[], OptimisticOp>(
    initialItems,
    (state, op) => {
      switch (op.type) {
        case 'create':
          return [op.draft, ...state];
        case 'update':
          return state.map((item) =>
            item.id === op.draft.id ? { ...op.draft, __pending: true } : item,
          );
        case 'patch':
          return state.map((item) =>
            item.id === op.id ? { ...item, ...op.patch, __pending: true } : item,
          );
        case 'remove':
          return state.filter((item) => item.id !== op.id);
      }
    },
  );

  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string[]>>({});
  const [createResetKey, setCreateResetKey] = useState(0);

  const [editingDeal, setEditingDeal] = useState<DealRow | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string[]>>({});

  const [actionError, setActionError] = useState<string | null>(null);

  // ---- Multi-select + bulk edit ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const selectableIds = optimisticItems
    .filter((d) => !d.id.startsWith('optimistic-'))
    .map((d) => d.id);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size >= selectableIds.length ? new Set() : new Set(selectableIds),
    );
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  function bulkStage(stage: DealStage) {
    const ids = [...selectedIds];
    startBulkTransition(async () => {
      for (const id of ids) {
        const deal = optimisticItems.find((d) => d.id === id);
        if (deal && deal.stage !== stage) {
          applyOptimistic({ type: 'patch', id, patch: { stage } });
        }
      }
      const results = await Promise.all(
        ids.map((id) => updateDealStageAction({ id, stage })),
      );
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} deal${ok > 1 ? 's' : ''} → ${DEAL_STAGE_LABELS[stage]}`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be moved`);
    });
  }

  function bulkOwner(ownerId: string | null) {
    const ids = [...selectedIds];
    startBulkTransition(async () => {
      for (const id of ids) applyOptimistic({ type: 'patch', id, patch: { ownerId } });
      const results = await Promise.all(
        ids.map((id) => updateDealOwnerAction({ id, ownerId })),
      );
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`Reassigned ${ok} deal${ok > 1 ? 's' : ''}`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be reassigned`);
    });
  }

  function bulkDelete() {
    const ids = [...selectedIds];
    if (!window.confirm(`Delete ${ids.length} deal${ids.length > 1 ? 's' : ''}? They can be restored from Recently deleted.`)) {
      return;
    }
    startBulkTransition(async () => {
      for (const id of ids) applyOptimistic({ type: 'remove', id });
      const results = await Promise.all(ids.map((id) => softDeleteDealAction(id)));
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} deal${ok > 1 ? 's' : ''} deleted`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be deleted`);
    });
  }

  const isFirstSearchRender = useRef(true);

  useEffect(() => {
    if (isFirstSearchRender.current) {
      isFirstSearchRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      startSearchTransition(() => {
        const params = new URLSearchParams();
        const trimmed = search.trim();
        if (trimmed) params.set('q', trimmed);
        if (pageSize !== 50) params.set('size', String(pageSize));
        const qs = params.toString();
        router.replace(`/dashboard/deals${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router, pageSize]);

  function buildOptimisticDraft(formData: FormData, base?: DealRow): DealItem {
    const name = String(formData.get('name') ?? '').trim();
    const stageRaw = String(formData.get('stage') ?? 'lead');
    const stage: DealStage = isDealStage(stageRaw) ? stageRaw : 'lead';
    const amountNum = Number(String(formData.get('amount') ?? '0'));
    const currency = String(formData.get('currency') ?? 'USD');
    const unitPriceRaw = String(formData.get('unitPrice') ?? '').trim();
    const quantityRaw = String(formData.get('quantity') ?? '').trim();
    const unitPriceMinor = unitPriceRaw !== ''
      ? toMinorUnits(Number(unitPriceRaw) || 0, currency)
      : base?.unitPriceMinor ?? null;
    const quantity = quantityRaw !== '' ? Number(quantityRaw) || 0 : base?.quantity ?? null;
    // Offer Price was removed from the form; preserve any stored value.
    const offerPriceMinor = base?.offerPriceMinor ?? null;
    const marginRaw = String(formData.get('marginPct') ?? '').trim();
    const marginBps = marginRaw !== '' ? marginPctToBps(Number(marginRaw) || 0) : null;
    const expectedCloseDate = String(formData.get('expectedCloseDate') ?? '').trim() || null;
    // Company/Contact are linked records; resolve display names from the form
    // options so the optimistic row shows the right labels until refresh.
    const companyId = (String(formData.get('companyId') ?? '').trim() || null) ?? base?.companyId ?? null;
    const contactId = (String(formData.get('contactId') ?? '').trim() || null) ?? base?.contactId ?? null;
    const companyName = companyId
      ? formCompanyOptions.find((c) => c.id === companyId)?.name ?? base?.companyName ?? null
      : null;
    const contact = contactId
      ? formContactOptions.find((c) => c.id === contactId)
      : undefined;
    const contactName = contact?.label ?? (contactId ? base?.contactName ?? null : null);
    // ownerId is posted only when the user can reassign (owner/manager); when
    // the field is absent, keep the deal's current owner.
    const ownerIdRaw = formData.get('ownerId');
    const ownerId =
      ownerIdRaw != null
        ? String(ownerIdRaw).trim() || null
        : base?.ownerId ?? null;

    const amountMinor = Number.isFinite(amountNum)
      ? toMinorUnits(amountNum, currency)
      : 0;

    const previousClosedAt = base?.closedAt ?? null;
    const isClosed = stage === 'won' || stage === 'lost';
    const closedAt = isClosed
      ? previousClosedAt ?? new Date()
      : null;

    // Optimistic approval state mirrors the server rule; realtime/refresh
    // reconciles the authoritative value.
    const wasWon = base?.stage === 'won';
    const nowWon = stage === 'won';
    let approvalStatus: DealItem['approvalStatus'] = base?.approvalStatus ?? 'none';
    let approvedBy = base?.approvedBy ?? null;
    let approvedAt = base?.approvedAt ?? null;
    if (nowWon && !wasWon) {
      if (canApproveDeals(currentRole)) {
        approvalStatus = 'approved';
        approvedBy = currentUserId;
        approvedAt = new Date();
      } else {
        approvalStatus = 'pending';
        approvedBy = null;
        approvedAt = null;
      }
    } else if (!nowWon) {
      approvalStatus = 'none';
      approvedBy = null;
      approvedAt = null;
    }

    return {
      id: base?.id ?? `optimistic-${crypto.randomUUID()}`,
      tenantId: base?.tenantId ?? '',
      companyId,
      contactId,
      name: name || base?.name || '(unnamed deal)',
      description:
        (String(formData.get('description') ?? '').trim() || base?.description) ?? null,
      stage,
      amountMinor,
      unitPriceMinor,
      quantity,
      offerPriceMinor,
      marginBps,
      approvalStatus,
      approvedBy,
      approvedAt,
      currency,
      expectedCloseDate,
      closedAt,
      ownerId,
      probability: base?.probability ?? null,
      createdAt: base?.createdAt ?? new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      companyNameText: null,
      contactNameText: null,
      contactEmailText: null,
      customFields: base?.customFields ?? {},
      updatedBy: currentUserId,
      companyName,
      contactName,
      contactEmail: contactId ? base?.contactEmail ?? null : null,
      __pending: true,
    };
  }

  function handleCreate(formData: FormData) {
    setCreateError(null);
    setCreateFieldErrors({});
    const draft = buildOptimisticDraft(formData);
    startCreateTransition(async () => {
      applyOptimistic({ type: 'create', draft });
      const result = await createDealAction(formData);
      if (!result.ok) {
        setCreateError(result.message);
        setCreateFieldErrors(result.fieldErrors ?? {});
      } else {
        setCreateResetKey((k) => k + 1);
      }
    });
  }

  function handleEditSubmit(formData: FormData) {
    if (!editingDeal) return;
    setEditError(null);
    setEditFieldErrors({});
    const draft = buildOptimisticDraft(formData, editingDeal);
    startEditTransition(async () => {
      applyOptimistic({ type: 'update', draft });
      const result = await updateDealAction(formData);
      if (!result.ok) {
        setEditError(result.message);
        setEditFieldErrors(result.fieldErrors ?? {});
      } else {
        setEditingDeal(null);
      }
    });
  }

  function handleDelete(deal: DealRow) {
    setActionError(null);
    startDeleteTransition(async () => {
      applyOptimistic({ type: 'remove', id: deal.id });
      const result = await softDeleteDealAction(deal.id);
      if (!result.ok) setActionError(result.message);
    });
  }

  function handleDeleteFromDrawer() {
    if (!editingDeal) return;
    handleDelete(editingDeal);
    setEditingDeal(null);
  }

  // ---- Inline cell editing (click-to-edit) ----
  // Build the optimistic row-patch + server payload for one field/value.
  function buildFieldPatch(
    deal: DealItem,
    field: EditableField,
    raw: string,
  ): { optimistic: Partial<DealItem>; server: Record<string, unknown> } {
    switch (field) {
      case 'amount': {
        const num = Number(raw) || 0;
        return {
          optimistic: { amountMinor: toMinorUnits(num, deal.currency) },
          server: { amount: num },
        };
      }
      case 'expectedCloseDate':
        return {
          optimistic: { expectedCloseDate: raw || null },
          server: { expectedCloseDate: raw || null },
        };
    }
  }

  function fieldRaw(deal: DealItem, field: EditableField): string {
    switch (field) {
      case 'amount':
        return String(fromMinorUnits(deal.amountMinor, deal.currency));
      case 'expectedCloseDate':
        return deal.expectedCloseDate ?? '';
    }
  }

  function runPatch(
    id: string,
    payload: { optimistic: Partial<DealItem>; server: Record<string, unknown> },
    onUndo?: () => void,
  ) {
    startEditTransition(async () => {
      applyOptimistic({ type: 'patch', id, patch: payload.optimistic });
      const res = await patchDealAction({ id, ...payload.server });
      if (!res.ok) {
        toast.error(res.message);
        return; // optimistic state reverts when the transition ends
      }
      if (onUndo) {
        toast.success('Updated', { action: { label: 'Undo', onClick: onUndo } });
      }
    });
  }

  function commitField(deal: DealItem, field: EditableField, raw: string) {
    const prev = fieldRaw(deal, field);
    if (raw === prev) return;
    const forward = buildFieldPatch(deal, field, raw);
    const reverse = buildFieldPatch(deal, field, prev);
    runPatch(deal.id, forward, () => runPatch(deal.id, reverse));
  }

  function commitOwner(deal: DealItem, ownerId: string | null) {
    if ((deal.ownerId ?? null) === ownerId) return;
    const prevOwner = deal.ownerId ?? null;
    runPatch(
      deal.id,
      { optimistic: { ownerId }, server: { ownerId } },
      () => runPatch(deal.id, { optimistic: { ownerId: prevOwner }, server: { ownerId: prevOwner } }),
    );
  }

  // Inline company change (clears the contact, which is company-scoped).
  function commitCompany(deal: DealItem, companyId: string) {
    const next = companyId || null;
    if ((deal.companyId ?? null) === next) return;
    const company = formCompanyOptions.find((c) => c.id === next);
    runPatch(
      deal.id,
      {
        optimistic: {
          companyId: next,
          companyName: company?.name ?? null,
          contactId: null,
          contactName: null,
          contactEmail: null,
        },
        server: { companyId: next, contactId: null },
      },
      () =>
        runPatch(deal.id, {
          optimistic: {
            companyId: deal.companyId,
            companyName: deal.companyName,
            contactId: deal.contactId,
            contactName: deal.contactName,
            contactEmail: deal.contactEmail,
          },
          server: { companyId: deal.companyId, contactId: deal.contactId },
        }),
    );
  }

  // Inline contact change (within the deal's company).
  function commitContact(deal: DealItem, contactId: string) {
    const next = contactId || null;
    if ((deal.contactId ?? null) === next) return;
    const contact = formContactOptions.find((c) => c.id === next);
    runPatch(
      deal.id,
      {
        optimistic: { contactId: next, contactName: contact?.label ?? null, contactEmail: null },
        server: { companyId: deal.companyId, contactId: next },
      },
      () =>
        runPatch(deal.id, {
          optimistic: {
            contactId: deal.contactId,
            contactName: deal.contactName,
            contactEmail: deal.contactEmail,
          },
          server: { companyId: deal.companyId, contactId: deal.contactId },
        }),
    );
  }

  // Inline stage edit — used by the stage-cell dropdown. Reuses the
  // existing kanban server action so the audit trail + automation
  // workflows fire identically regardless of where the move came from.
  const [stagePending, startStageTransition] = useTransition();
  function handleStageChange(
    deal: DealRow,
    nextStage: DealStage,
    opts?: { undo?: boolean },
  ) {
    if (deal.stage === nextStage) return;
    const prevStage = deal.stage;
    const optimisticDraft: DealItem = {
      ...deal,
      stage: nextStage,
      closedAt:
        nextStage === 'won' || nextStage === 'lost'
          ? deal.closedAt ?? new Date()
          : null,
      updatedAt: new Date(),
      __pending: true,
    };
    startStageTransition(async () => {
      applyOptimistic({ type: 'update', draft: optimisticDraft });
      const result = await updateDealStageAction({
        id: deal.id,
        stage: nextStage,
      });
      if (!result.ok) {
        toast.error(`Couldn't change stage: ${result.message}`);
      } else if (result.changed && !opts?.undo) {
        toast.success(`${deal.name} → ${DEAL_STAGE_LABELS[nextStage]}`, {
          action: {
            label: 'Undo',
            onClick: () =>
              handleStageChange({ ...deal, stage: nextStage }, prevStage, {
                undo: true,
              }),
          },
        });
      }
    });
  }

  const showEmpty = optimisticItems.length === 0;
  const trimmedSearch = search.trim();

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deals by name…"
              aria-label="Search deals"
              className={cn(
                'w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm shadow-sm transition',
                'placeholder:text-slate-400',
                'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
                '',
              )}
            />
            {searchPending ? (
              <Loader2
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
                aria-hidden
              />
            ) : null}
          </div>
          {canEdit ? (
            <>
              <BulkUploadButton />
              <CreateDrawer
                label="New deal"
                drawerTitle="Create deal"
                description="Track an opportunity through your pipeline."
                closeOnSuccessKey={createResetKey}
              >
                {() => (
                  <CreateDealForm
                    onSubmit={handleCreate}
                    pending={createPending}
                    error={createError}
                    fieldErrors={createFieldErrors}
                    resetKey={createResetKey}
                    companyOptions={formCompanyOptions}
                    contactOptions={formContactOptions}
                    teammates={teammates}
                    currentUserId={currentUserId}
                    currentRole={currentRole}
                    customFieldDefs={customFieldDefs}
                    unitPricingEnabled={unitPricingEnabled}
                  />
                )}
              </CreateDrawer>
            </>
          ) : null}
        </div>

        <DealFilterBar
          initialFilters={initialFilters}
          companyOptions={companyOptions}
          teammates={teammates}
        />

        <FilterChips chips={filterChips} />

        <SavedViews userId={currentUserId} />

        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </p>
        ) : null}

        {(canEdit || canDelete) && selectedIds.size > 0 ? (
          <BulkBar
            count={selectedIds.size}
            pending={bulkPending}
            canEdit={canEdit}
            canDelete={canDelete}
            canAssign={canAssign}
            assignable={assignable}
            currentUserId={currentUserId}
            onStage={bulkStage}
            onOwner={bulkOwner}
            onDelete={bulkDelete}
            onClear={clearSelection}
          />
        ) : null}

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <DealsTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              unitPricingEnabled={unitPricingEnabled}
              teammates={teammates}
              currentUserId={currentUserId}
              canAssignOwner={canAssign}
              assignableTeammates={assignable}
              companyOptions={formCompanyOptions}
              contactOptions={formContactOptions}
              onPatchCompany={commitCompany}
              onPatchContact={commitContact}
              selectable={canEdit || canDelete}
              selectedIds={selectedIds}
              allSelected={allSelected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onEdit={(d) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingDeal(d);
              }}
              onDelete={handleDelete}
              onStageChange={handleStageChange}
              onPatchField={commitField}
              onPatchOwner={commitOwner}
              stagePending={stagePending}
              deletePending={deletePending}
            />
            <PaginationControls
              basePath="/dashboard/deals"
              nextCursor={nextCursor}
              size={pageSize}
              visibleCount={optimisticItems.length}
            />
          </div>
        )}
      </section>

      <EditDealDrawer
        open={editingDeal !== null}
        onClose={() => setEditingDeal(null)}
        deal={editingDeal}
        companyOptions={formCompanyOptions}
        contactOptions={formContactOptions}
        teammates={teammates}
        currentUserId={currentUserId}
        currentRole={currentRole}
        customFieldDefs={customFieldDefs}
        unitPricingEnabled={unitPricingEnabled}
        onSubmit={handleEditSubmit}
        onDelete={handleDeleteFromDrawer}
        pending={editPending}
        deletePending={deletePending}
        error={editError}
        fieldErrors={editFieldErrors}
        canDelete={canDelete}
      />
    </div>
  );
}

function DealsTable({
  items,
  canEdit,
  canDelete,
  unitPricingEnabled,
  teammates,
  currentUserId,
  canAssignOwner,
  assignableTeammates,
  companyOptions,
  contactOptions,
  onPatchCompany,
  onPatchContact,
  selectable,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onEdit,
  onDelete,
  onStageChange,
  onPatchField,
  onPatchOwner,
  stagePending,
  deletePending,
}: {
  items: DealItem[];
  canEdit: boolean;
  canDelete: boolean;
  unitPricingEnabled: boolean;
  teammates: Teammate[];
  currentUserId: string;
  canAssignOwner: boolean;
  assignableTeammates: Teammate[];
  companyOptions: CompanyOption[];
  contactOptions: ContactPickerOption[];
  onPatchCompany: (deal: DealItem, companyId: string) => void;
  onPatchContact: (deal: DealItem, contactId: string) => void;
  selectable: boolean;
  selectedIds: Set<string>;
  allSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (deal: DealRow) => void;
  onDelete: (deal: DealRow) => void;
  onStageChange: (deal: DealRow, next: DealStage) => void;
  onPatchField: (deal: DealItem, field: EditableField, raw: string) => void;
  onPatchOwner: (deal: DealItem, ownerId: string | null) => void;
  stagePending: boolean;
  deletePending: boolean;
}) {
  const teammateById = new Map(teammates.map((t) => [t.id, t]));
  const companySelectOptions = companyOptions.map((c) => ({ value: c.id, label: c.name }));
  const showActions = canEdit || canDelete;
  return (
    <>
      {/* Mobile / narrow viewports: stacked card list. The table below
          is hidden on small screens so we never force horizontal scroll. */}
      <ul className="flex flex-col divide-y divide-slate-100 sm:hidden">
        {items.map((d) => {
          const isOptimistic = d.id.startsWith('optimistic-');
          return (
            <li
              key={d.id}
              className={cn(
                'flex flex-col gap-1.5 px-3 py-2.5 transition-colors',
                d.__pending && 'opacity-60',
              )}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {isOptimistic ? (
                    <span className="text-[13px] font-medium">{d.name}</span>
                  ) : (
                    <Link
                      href={`/dashboard/deals/${d.id}`}
                      className="text-[13px] font-medium hover:underline"
                    >
                      {d.name}
                    </Link>
                  )}
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    {d.companyName ?? 'No company'}
                    {d.contactName || d.contactEmail
                      ? ` · ${d.contactName ?? d.contactEmail}`
                      : ''}
                  </p>
                  {d.contactName && d.contactEmail ? (
                    <p className="truncate text-[11px] text-slate-400">{d.contactEmail}</p>
                  ) : null}
                </div>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-slate-700">
                  {formatCurrency(d.amountMinor, d.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {canEdit && !isOptimistic ? (
                    <InlineStageSelect
                      deal={d}
                      onChange={(next) => onStageChange(d, next)}
                      pending={stagePending && d.__pending === true}
                    />
                  ) : (
                    <StageBadge stage={d.stage} />
                  )}
                  <OwnerCell
                    ownerId={d.ownerId}
                    teammate={d.ownerId ? teammateById.get(d.ownerId) : undefined}
                    compact
                  />
                </div>
                {showActions ? (
                  <RowActions
                    canEdit={canEdit}
                    canDelete={canDelete}
                    onEdit={() => onEdit(d)}
                    onDelete={() => onDelete(d)}
                    busy={deletePending && d.__pending === true}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto overscroll-x-contain sm:block">
      <table className="min-w-[60rem] divide-y divide-slate-200 text-[13px]">
        <thead className="sticky top-0 z-10 bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-20 bg-slate-50/95 px-3 py-1.5 text-left font-semibold backdrop-blur"
              >
                <span className="flex items-center gap-2">
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={onToggleSelectAll}
                      aria-label="Select all deals"
                      className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  ) : null}
                  Name
                </span>
              </th>
              <th scope="col" className="px-3 py-1.5 text-left font-semibold">
                Stage
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                Amount
              </th>
              <th
                scope="col"
                className="hidden px-3 py-1.5 text-left font-semibold md:table-cell"
              >
                Company
              </th>
              <th
                scope="col"
                className="hidden px-3 py-1.5 text-left font-semibold lg:table-cell"
              >
                Contact
              </th>
              <th
                scope="col"
                className="hidden px-3 py-1.5 text-left font-semibold md:table-cell"
              >
                Owner
              </th>
              <th
                scope="col"
                className="hidden px-3 py-1.5 text-right font-semibold sm:table-cell"
              >
                Close date
              </th>
              {showActions ? (
                <th
                  scope="col"
                  className="sticky right-0 z-10 bg-slate-50/95 px-3 py-1.5 text-right font-semibold backdrop-blur"
                >
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((d) => {
              const isOptimistic = d.id.startsWith('optimistic-');
              return (
                <tr
                  key={d.id}
                  className={cn(
                    'group transition-colors hover:bg-slate-50/70',
                    d.__pending && 'opacity-60',
                  )}
                >
                  <td className="sticky left-0 z-[1] bg-white/95 px-3 py-2 backdrop-blur group-hover:bg-slate-50/95">
                    <div className="flex items-center gap-2">
                      {selectable && !isOptimistic ? (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(d.id)}
                          onChange={() => onToggleSelect(d.id)}
                          aria-label={`Select ${d.name}`}
                          className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      ) : null}
                      {isOptimistic ? (
                        <span className="font-medium">{d.name}</span>
                      ) : (
                        <Link
                          href={`/dashboard/deals/${d.id}`}
                          className="inline-flex items-center gap-1 font-medium hover:underline"
                        >
                          {d.name}
                          <ExternalLink className="h-3 w-3 text-slate-400" aria-hidden />
                        </Link>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {canEdit && !isOptimistic ? (
                      <InlineStageSelect
                        deal={d}
                        onChange={(next) => onStageChange(d, next)}
                        pending={stagePending && d.__pending === true}
                      />
                    ) : (
                      <StageBadge stage={d.stage} />
                    )}
                  </td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-right font-mono"
                    title={
                      unitPricingEnabled ||
                      (d.unitPriceMinor != null && d.quantity != null)
                        ? 'Amount is calculated from Per Unit Price × Qty — edit those on the deal'
                        : undefined
                    }
                  >
                    <InlineEditCell
                      ariaLabel="amount"
                      type="number"
                      step="0.01"
                      min="0"
                      align="right"
                      // Amount is derived (price × qty) when the workspace has
                      // unit pricing on, OR the deal already carries unit price +
                      // qty (even after the workspace toggle is turned off) — so
                      // it isn't editable inline; edit via the deal form.
                      disabled={
                        !canEdit ||
                        isOptimistic ||
                        unitPricingEnabled ||
                        (d.unitPriceMinor != null && d.quantity != null)
                      }
                      value={String(fromMinorUnits(d.amountMinor, d.currency))}
                      render={() => formatCurrency(d.amountMinor, d.currency)}
                      onCommit={(v) => onPatchField(d, 'amount', v)}
                    />
                  </td>
                  <td className="hidden px-3 py-2 text-slate-600 md:table-cell">
                    <InlineSelectCell
                      ariaLabel="company"
                      disabled={!canEdit || isOptimistic}
                      value={d.companyId ?? ''}
                      options={companySelectOptions}
                      render={d.companyName ?? '—'}
                      emptyLabel="— No company —"
                      onCommit={(v) => onPatchCompany(d, v)}
                    />
                  </td>
                  <td className="hidden px-3 py-2 text-slate-600 lg:table-cell">
                    <InlineSelectCell
                      ariaLabel="contact"
                      disabled={!canEdit || isOptimistic || !d.companyId}
                      value={d.contactId ?? ''}
                      options={contactOptions
                        .filter((c) => c.companyId === d.companyId)
                        .map((c) => ({ value: c.id, label: c.label }))}
                      render={
                        d.contactName ?? d.contactEmail ?? (d.companyId ? '—' : 'Pick a company')
                      }
                      emptyLabel="— No contact —"
                      onCommit={(v) => onPatchContact(d, v)}
                    />
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    <InlineOwnerCell
                      deal={d}
                      teammate={d.ownerId ? teammateById.get(d.ownerId) : undefined}
                      teammates={assignableTeammates}
                      currentUserId={currentUserId}
                      disabled={!canAssignOwner || isOptimistic}
                      onSelect={(ownerId) => onPatchOwner(d, ownerId)}
                    />
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 sm:table-cell">
                    <InlineEditCell
                      ariaLabel="close date"
                      type="date"
                      align="right"
                      disabled={!canEdit || isOptimistic}
                      value={d.expectedCloseDate ?? ''}
                      render={(v) =>
                        v ? dateFormatter.format(new Date(v)) : <span className="text-slate-400">—</span>
                      }
                      onCommit={(v) => onPatchField(d, 'expectedCloseDate', v)}
                    />
                  </td>
                  {showActions ? (
                    <td className="sticky right-0 z-[1] whitespace-nowrap bg-white/95 px-3 py-2 text-right backdrop-blur group-hover:bg-slate-50/95">
                      <RowActions
                        canEdit={canEdit}
                        canDelete={canDelete}
                        onEdit={() => onEdit(d)}
                        onDelete={() => onDelete(d)}
                        busy={deletePending && d.__pending === true}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
        </tbody>
      </table>
      </div>
    </>
  );
}

function InlineStageSelect({
  deal,
  onChange,
  pending,
}: {
  deal: DealItem;
  onChange: (next: DealStage) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Close on outside-click via a window-level handler installed only
  // while the popover is mounted.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 rounded transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change stage"
      >
        <StageBadge stage={deal.stage} />
        {pending ? (
          <Loader2
            className="h-3 w-3 animate-spin text-slate-400"
            aria-hidden
          />
        ) : (
          <ChevronDown
            className="h-3 w-3 text-slate-400 transition-transform"
            aria-hidden
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
          />
        )}
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 min-w-[8rem] overflow-hidden rounded-md border border-slate-200 bg-white py-0.5 shadow-md"
        >
          {DEAL_STAGES.map((stage) => (
            <li key={stage}>
              <button
                type="button"
                role="option"
                aria-selected={stage === deal.stage}
                onClick={() => {
                  setOpen(false);
                  onChange(stage);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[12px] transition',
                  stage === deal.stage
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-700 hover:bg-slate-50',
                )}
              >
                <span className="capitalize">{DEAL_STAGE_LABELS[stage]}</span>
                {stage === deal.stage ? (
                  <span className="text-[10px] text-indigo-500">current</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RowActions({
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  busy,
}: {
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming && canDelete) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {canEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Delete"
          className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Compact owner cell. Shows avatar + name when the teammate lookup
 * resolves; falls back to a muted "Unassigned" pill otherwise. The
 * compact variant (mobile cards) hides the name and keeps only the
 * avatar to save space.
 */
function OwnerCell({
  ownerId,
  teammate,
  compact,
}: {
  ownerId: string | null;
  teammate: Teammate | undefined;
  compact?: boolean;
}) {
  if (!ownerId) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-dashed border-slate-300" />
        {!compact ? <span>Unassigned</span> : null}
      </span>
    );
  }
  const name = teammate?.displayName ?? ownerId;
  const initials = name
    .split(/\s+|-/)
    .map((p) => (p[0] ?? '').toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join('') || '?';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-600" title={name}>
      {teammate?.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={teammate.imageUrl}
          alt=""
          className="h-4 w-4 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-700">
          {initials}
        </span>
      )}
      {!compact ? <span className="truncate">{name}</span> : null}
    </span>
  );
}

/** Floating action bar for the current multi-selection. */
function BulkBar({
  count,
  pending,
  canEdit,
  canDelete,
  canAssign,
  assignable,
  currentUserId,
  onStage,
  onOwner,
  onDelete,
  onClear,
}: {
  count: number;
  pending: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canAssign: boolean;
  assignable: Teammate[];
  currentUserId: string;
  onStage: (s: DealStage) => void;
  onOwner: (ownerId: string | null) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [stageOpen, setStageOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!stageOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (stageRef.current && !stageRef.current.contains(e.target as Node)) {
        setStageOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [stageOpen]);

  const triggerCls =
    'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[13px]">
      <span className="font-medium text-indigo-900">{count} selected</span>
      <span className="h-4 w-px bg-indigo-200" aria-hidden />

      {canEdit ? (
        <div className="relative" ref={stageRef}>
          <button type="button" disabled={pending} onClick={() => setStageOpen((v) => !v)} className={triggerCls}>
            Set stage
            <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden />
          </button>
          {stageOpen ? (
            <ul className="absolute left-0 top-full z-40 mt-1 min-w-[9rem] overflow-hidden rounded-md border border-slate-200 bg-white py-0.5 shadow-md">
              {DEAL_STAGES.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => {
                      setStageOpen(false);
                      onStage(s);
                    }}
                    className="flex w-full items-center px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-50"
                  >
                    {DEAL_STAGE_LABELS[s]}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {canAssign ? (
        <div className="relative">
          <button type="button" disabled={pending} onClick={() => setOwnerOpen((v) => !v)} className={triggerCls}>
            Assign owner
            <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden />
          </button>
          <TeammatePicker
            open={ownerOpen}
            onOpenChange={setOwnerOpen}
            teammates={assignable}
            currentUserId={currentUserId}
            selectedId={null}
            onSelect={(t) => {
              setOwnerOpen(false);
              onOwner(t.id);
            }}
            onUnassign={() => {
              setOwnerOpen(false);
              onOwner(null);
            }}
          />
        </div>
      ) : null}

      {canDelete ? (
        <button
          type="button"
          disabled={pending}
          onClick={onDelete}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
      ) : null}

      {pending ? <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden /> : null}

      <button type="button" onClick={onClear} className="ml-auto rounded-md px-2 py-1 text-[12px] font-medium text-indigo-700 hover:bg-indigo-100">
        Clear
      </button>
    </div>
  );
}

/** Owner cell that opens the teammate picker on click (inline reassignment). */
function InlineOwnerCell({
  deal,
  teammate,
  teammates,
  currentUserId,
  disabled,
  onSelect,
}: {
  deal: DealItem;
  teammate: Teammate | undefined;
  teammates: Teammate[];
  currentUserId: string;
  disabled?: boolean;
  onSelect: (ownerId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  if (disabled) {
    return <OwnerCell ownerId={deal.ownerId} teammate={teammate} />;
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Assign owner"
        title="Assign owner"
        className="rounded px-1 py-0.5 text-left transition hover:bg-slate-100 hover:ring-1 hover:ring-slate-200"
      >
        <OwnerCell ownerId={deal.ownerId} teammate={teammate} />
      </button>
      <TeammatePicker
        open={open}
        onOpenChange={setOpen}
        teammates={teammates}
        currentUserId={currentUserId}
        selectedId={deal.ownerId}
        onSelect={(t) => {
          onSelect(t.id);
          setOpen(false);
        }}
        onUnassign={() => {
          onSelect(null);
          setOpen(false);
        }}
      />
    </div>
  );
}

function formatAmountMinor(minor: number): string {
  // Lightweight money formatting just for the chip label — full currency
  // formatting lives in `formatCurrency` but that needs a currency code,
  // which the filter (range across all currencies) doesn't have.
  return new Intl.NumberFormat('en-US').format(Math.round(minor / 100));
}

function buildDealFilterChips(
  filters: DealFilters,
  ctx: {
    companyOptions: CompanyOption[];
    teammates: Teammate[];
    currentUserId: string;
  },
): FilterChip[] {
  const chips: FilterChip[] = [];

  if (filters.stages && filters.stages.length > 0) {
    chips.push({
      id: 'stages',
      keys: ['stage', 'stages'],
      label: `Stage: ${filters.stages.map((s) => DEAL_STAGE_LABELS[s]).join(', ')}`,
    });
  }
  if (filters.amountMinorMin !== undefined || filters.amountMinorMax !== undefined) {
    const lo = filters.amountMinorMin !== undefined
      ? formatAmountMinor(filters.amountMinorMin)
      : '0';
    const hi = filters.amountMinorMax !== undefined
      ? formatAmountMinor(filters.amountMinorMax)
      : '∞';
    chips.push({
      id: 'amount',
      keys: ['amountMin', 'amountMax'],
      label: `Amount: ${lo} – ${hi}`,
    });
  }
  if (filters.expectedCloseFrom || filters.expectedCloseTo) {
    chips.push({
      id: 'close',
      keys: ['closeFrom', 'closeTo'],
      label: `Close: ${filters.expectedCloseFrom ?? '∞'} → ${filters.expectedCloseTo ?? '∞'}`,
    });
  }
  if (filters.stale) {
    chips.push({
      id: 'stale',
      keys: ['stale', 'staleDays'],
      label: `Stale (>${filters.staleDays ?? 14}d)`,
    });
  }
  if (filters.companyIds && filters.companyIds.length > 0) {
    const names = filters.companyIds
      .map(
        (id) =>
          ctx.companyOptions.find((c) => c.id === id)?.name ?? 'Unknown',
      )
      .slice(0, 3);
    const suffix =
      filters.companyIds.length > names.length
        ? ` +${filters.companyIds.length - names.length}`
        : '';
    chips.push({
      id: 'companies',
      keys: ['companyId', 'companyIds'],
      label: `Company: ${names.join(', ')}${suffix}`,
    });
  }
  if (filters.mine) {
    chips.push({ id: 'mine', keys: ['mine'], label: 'Mine' });
  }
  if (filters.unassigned) {
    chips.push({ id: 'unassigned', keys: ['unassigned'], label: 'Unassigned' });
  }
  if (filters.ownerIds && filters.ownerIds.length > 0) {
    const names = filters.ownerIds
      .map(
        (id) =>
          ctx.teammates.find((t) => t.id === id)?.displayName ??
          id.slice(0, 8),
      )
      .slice(0, 3);
    const suffix =
      filters.ownerIds.length > names.length
        ? ` +${filters.ownerIds.length - names.length}`
        : '';
    chips.push({
      id: 'owners',
      keys: ['owner'],
      label: `Owner: ${names.join(', ')}${suffix}`,
    });
  }

  return chips;
}
