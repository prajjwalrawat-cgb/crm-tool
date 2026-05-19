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
import type { ContactOption } from '@/lib/contacts/queries';
import type { Teammate } from '@/lib/teammates/queries';
import { formatCurrency, toMinorUnits } from '@/lib/deals/currency';
import type { DealFilters } from '@/lib/deals/filters';
import type { DealRow } from '@/lib/deals/queries';
import type { PageSize } from '@/lib/pagination/page-size';
import {
  type DealStage,
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
} from '@/lib/deals/schema';
import { canDeleteDeals, canManageDeals } from '@/lib/rbac';
import { cn } from '@/lib/utils';

import { CreateDrawer } from '../../_components/create-drawer';
import { FilterChips, type FilterChip } from '../../_components/filter-chips';
import { PaginationControls } from '../../_components/pagination-controls';
import {
  createDealAction,
  softDeleteDealAction,
  updateDealAction,
  updateDealStageAction,
} from '../actions';
import { CreateDealForm } from './create-deal-form';
import { DealFilterBar } from './deal-filter-bar';
import { EditDealDrawer } from './edit-deal-drawer';
import { EmptyState } from './empty-state';
import { StageBadge } from './stage-badge';

type DealItem = DealRow & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: DealItem }
  | { type: 'update'; draft: DealItem }
  | { type: 'remove'; id: string };

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
  contactOptions,
  teammates,
  currentUserId,
  currentRole,
  nextCursor,
  pageSize,
}: {
  initialItems: DealRow[];
  initialSearch: string;
  initialFilters: DealFilters;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
}) {
  const router = useRouter();
  const canEdit = canManageDeals(currentRole);
  const canDelete = canDeleteDeals(currentRole);
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
    const expectedCloseDate = String(formData.get('expectedCloseDate') ?? '').trim() || null;
    const companyId = String(formData.get('companyId') ?? '').trim() || null;
    const contactId = String(formData.get('contactId') ?? '').trim() || null;

    const companyName = companyId
      ? companyOptions.find((c) => c.id === companyId)?.name ?? null
      : null;
    const contact = contactId
      ? contactOptions.find((c) => c.id === contactId) ?? null
      : null;

    const amountMinor = Number.isFinite(amountNum)
      ? toMinorUnits(amountNum, currency)
      : 0;

    const previousClosedAt = base?.closedAt ?? null;
    const isClosed = stage === 'won' || stage === 'lost';
    const closedAt = isClosed
      ? previousClosedAt ?? new Date()
      : null;

    return {
      id: base?.id ?? `optimistic-${crypto.randomUUID()}`,
      tenantId: base?.tenantId ?? '',
      companyId,
      contactId,
      name: name || base?.name || '(unnamed deal)',
      stage,
      amountMinor,
      currency,
      expectedCloseDate,
      closedAt,
      ownerId: base?.ownerId ?? null,
      probability: base?.probability ?? null,
      createdAt: base?.createdAt ?? new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      companyName,
      contactName: contact?.label ?? null,
      contactEmail: base?.contactEmail ?? null,
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

  // Inline stage edit — used by the stage-cell dropdown. Reuses the
  // existing kanban server action so the audit trail + automation
  // workflows fire identically regardless of where the move came from.
  const [stagePending, startStageTransition] = useTransition();
  function handleStageChange(deal: DealRow, nextStage: DealStage) {
    if (deal.stage === nextStage) return;
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
      } else if (result.changed) {
        toast.success(
          `${deal.name} → ${DEAL_STAGE_LABELS[nextStage]}`,
        );
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
                  companyOptions={companyOptions}
                  contactOptions={contactOptions}
                  teammates={teammates}
                  currentUserId={currentUserId}
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

        <DealFilterBar
          initialFilters={initialFilters}
          companyOptions={companyOptions}
        />

        <FilterChips chips={filterChips} />

        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </p>
        ) : null}

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <DealsTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              teammates={teammates}
              onEdit={(d) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingDeal(d);
              }}
              onDelete={handleDelete}
              onStageChange={handleStageChange}
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
        companyOptions={companyOptions}
        contactOptions={contactOptions}
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
  teammates,
  onEdit,
  onDelete,
  onStageChange,
  stagePending,
  deletePending,
}: {
  items: DealItem[];
  canEdit: boolean;
  canDelete: boolean;
  teammates: Teammate[];
  onEdit: (deal: DealRow) => void;
  onDelete: (deal: DealRow) => void;
  onStageChange: (deal: DealRow, next: DealStage) => void;
  stagePending: boolean;
  deletePending: boolean;
}) {
  const teammateById = new Map(teammates.map((t) => [t.id, t]));
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
                Name
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
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                    {formatCurrency(d.amountMinor, d.currency)}
                  </td>
                  <td className="hidden px-3 py-2 text-slate-600 md:table-cell">
                    {d.companyName ?? '—'}
                  </td>
                  <td className="hidden px-3 py-2 text-slate-600 lg:table-cell">
                    {d.contactName ?? d.contactEmail ?? '—'}
                  </td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    <OwnerCell
                      ownerId={d.ownerId}
                      teammate={d.ownerId ? teammateById.get(d.ownerId) : undefined}
                    />
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 sm:table-cell">
                    {d.expectedCloseDate
                      ? dateFormatter.format(new Date(d.expectedCloseDate))
                      : '—'}
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
  if (filters.companyId) {
    const co = ctx.companyOptions.find((c) => c.id === filters.companyId);
    chips.push({
      id: 'company',
      keys: ['companyId'],
      label: `Company: ${co?.name ?? 'Unknown'}`,
    });
  }
  if (filters.mine) {
    chips.push({ id: 'mine', keys: ['mine'], label: 'Mine' });
  }
  if (filters.unassigned) {
    chips.push({ id: 'unassigned', keys: ['unassigned'], label: 'Unassigned' });
  }
  if (filters.ownerId) {
    const t = ctx.teammates.find((tt) => tt.id === filters.ownerId);
    chips.push({
      id: 'owner',
      keys: ['owner'],
      label: `Owner: ${t?.displayName ?? filters.ownerId.slice(0, 8)}`,
    });
  }

  return chips;
}
