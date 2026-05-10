'use client';

import { ExternalLink, Loader2, Pencil, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';

import type { MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import { formatCurrency, toMinorUnits } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import type { PageSize } from '@/lib/pagination/page-size';
import { type DealStage, DEAL_STAGES } from '@/lib/deals/schema';
import { canDeleteDeals, canManageDeals } from '@/lib/rbac';
import { cn } from '@/lib/utils';

import { CreateDrawer } from '../../_components/create-drawer';
import { PaginationControls } from '../../_components/pagination-controls';
import {
  createDealAction,
  softDeleteDealAction,
  updateDealAction,
} from '../actions';
import { CreateDealForm } from './create-deal-form';
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
  companyOptions,
  contactOptions,
  currentRole,
  nextCursor,
  pageSize,
}: {
  initialItems: DealRow[];
  initialSearch: string;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
}) {
  const router = useRouter();
  const canEdit = canManageDeals(currentRole);
  const canDelete = canDeleteDeals(currentRole);

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

  const showEmpty = optimisticItems.length === 0;
  const trimmedSearch = search.trim();

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deals by name…"
              aria-label="Search deals"
              className={cn(
                'w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-9 text-sm shadow-sm transition',
                'placeholder:text-zinc-400',
                'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
                'dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-500',
              )}
            />
            {searchPending ? (
              <Loader2
                className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400"
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
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {actionError}
          </p>
        ) : null}

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <DealsTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={(d) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingDeal(d);
              }}
              onDelete={handleDelete}
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
  onEdit,
  onDelete,
  deletePending,
}: {
  items: DealItem[];
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (deal: DealRow) => void;
  onDelete: (deal: DealRow) => void;
  deletePending: boolean;
}) {
  const showActions = canEdit || canDelete;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="sticky top-0 z-10 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Stage
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Amount
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium md:table-cell"
              >
                Company
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium lg:table-cell"
              >
                Contact
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right font-medium sm:table-cell"
              >
                Close date
              </th>
              {showActions ? (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((d) => {
              const isOptimistic = d.id.startsWith('optimistic-');
              return (
                <tr
                  key={d.id}
                  className={cn('transition-opacity', d.__pending && 'opacity-60')}
                >
                  <td className="px-3 py-2">
                    {isOptimistic ? (
                      <span className="font-medium">{d.name}</span>
                    ) : (
                      <Link
                        href={`/dashboard/deals/${d.id}`}
                        className="inline-flex items-center gap-1 font-medium hover:underline"
                      >
                        {d.name}
                        <ExternalLink className="h-3 w-3 text-zinc-400" aria-hidden />
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StageBadge stage={d.stage} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                    {formatCurrency(d.amountMinor, d.currency)}
                  </td>
                  <td className="hidden px-3 py-2 text-zinc-600 md:table-cell dark:text-zinc-400">
                    {d.companyName ?? '—'}
                  </td>
                  <td className="hidden px-3 py-2 text-zinc-600 lg:table-cell dark:text-zinc-400">
                    {d.contactName ?? d.contactEmail ?? '—'}
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-zinc-500 sm:table-cell">
                    {d.expectedCloseDate
                      ? dateFormatter.format(new Date(d.expectedCloseDate))
                      : '—'}
                  </td>
                  {showActions ? (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
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
          className="rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
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
          className="rounded-md border border-zinc-200 p-1 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Delete"
          className="rounded-md border border-zinc-200 p-1 text-zinc-600 hover:bg-red-50 hover:text-red-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
