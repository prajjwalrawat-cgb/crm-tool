'use client';

import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  Loader2,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';

import type { Company, MembershipRole } from '@/db/schema';
import {
  type CompanySort,
  COMPANY_SORT_URL_KEYS,
  type SortDir,
} from '@/lib/companies/filters';
import {
  type CompanyRollupFields,
  EMPTY_COMPANY_ROLLUP,
  formatCount,
  hasOpenPipeline,
  hasWonValue,
} from '@/lib/companies/rollup';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { CustomFieldDef } from '@/lib/custom-fields/types';
import { RelativeTime } from '@/lib/dates/relative-time';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import type { PageSize } from '@/lib/pagination/page-size';
import { canDeleteCompanies, canManageCompanies } from '@/lib/rbac';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { BulkActionBar } from '../../_components/bulk-action-bar';
import { CreateDrawer } from '../../_components/create-drawer';
import { HoverPrefetchLink } from '../../_components/hover-prefetch-link';
import { InlineEditCell } from '../../_components/inline-edit-cell';
import { PaginationControls } from '../../_components/pagination-controls';
import { ToggleFilterBar } from '../../_components/toggle-filter-bar';
import {
  createCompanyAction,
  patchCompanyAction,
  softDeleteCompanyAction,
  updateCompanyAction,
} from '../actions';

type CompanyField = 'name' | 'domain' | 'industry';
import { CreateCompanyForm } from './create-company-form';
import { EditCompanyDrawer } from './edit-company-drawer';
import { EmptyState } from './empty-state';

/**
 * A row carries its rollup with it. `rollup` is never optional: a row
 * without one would have to be rendered as "unknown" in six cells, and
 * the only rows that legitimately have no rollup yet are optimistic ones,
 * which get `EMPTY_COMPANY_ROLLUP` — a company created a moment ago
 * genuinely has no deals, no contacts and no history.
 */
type CompanyItem = Company & {
  rollup: CompanyRollupFields;
  __pending?: boolean;
};

const STAGE_BADGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-600',
  qualified: 'bg-blue-100 text-blue-700',
  proposal: 'bg-indigo-100 text-indigo-700',
  negotiation: 'bg-amber-100 text-amber-800',
  hold: 'bg-orange-100 text-orange-700',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-rose-100 text-rose-700',
};

type OptimisticOp =
  | { type: 'create'; draft: CompanyItem }
  | { type: 'update'; draft: CompanyItem }
  | { type: 'patch'; id: string; patch: Partial<CompanyItem> }
  | { type: 'remove'; id: string };

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function CompaniesView({
  initialItems,
  initialSearch,
  teammates,
  currentUserId,
  currentRole,
  nextCursor,
  pageSize,
  customFieldDefs,
  sort,
  dir,
  currencyContext,
}: {
  initialItems: CompanyItem[];
  initialSearch: string;
  teammates: Teammate[];
  currentUserId: string;
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
  customFieldDefs: CustomFieldDef[];
  sort: CompanySort;
  dir: SortDir;
  currencyContext: TenantCurrencyContext;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canEdit = canManageCompanies(currentRole);
  const canDelete = canDeleteCompanies(currentRole);

  /**
   * Sorting is a URL mode, not component state — same rule the filter
   * chips follow, and the same one the deals list settled on. A reload or
   * a shared link reproduces the order, and paging keeps working because
   * the server hands back a cursor for the mode it actually ordered by.
   *
   * Clicking the active column flips direction; clicking a different one
   * starts it at that column's natural direction (descending — biggest
   * pipeline, most recent activity, most deals first). Clicking the
   * active column while already ascending returns to the default order
   * rather than cycling forever through two states you cannot leave.
   */
  const pushSort = (next: CompanySort) => {
    const merged = new URLSearchParams(searchParams.toString());
    merged.delete('cursor');
    if (sort === next) {
      if (dir === 'desc') {
        merged.set('sort', next);
        merged.set('dir', 'asc');
      } else {
        for (const k of COMPANY_SORT_URL_KEYS) merged.delete(k);
      }
    } else {
      merged.set('sort', next);
      merged.delete('dir');
    }
    const qs = merged.toString();
    router.replace(`/dashboard/companies${qs ? `?${qs}` : ''}`, {
      scroll: false,
    });
  };

  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();
  const [editPending, startEditTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();

  const [optimisticItems, applyOptimistic] = useOptimistic<CompanyItem[], OptimisticOp>(
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

  const [editingCompany, setEditingCompany] = useState<CompanyItem | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string[]>>({});

  const [actionError, setActionError] = useState<string | null>(null);

  const isFirstSearchRender = useRef(true);

  /**
   * Read through a ref, not a dependency. The debounced effect below must
   * fire when the SEARCH TEXT changes and at no other time: if the live
   * `searchParams` were a dependency, clicking "Next" would change the
   * URL, re-run this effect, and the effect would strip the cursor it
   * just gained — paging would snap back to page one.
   */
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  useEffect(() => {
    if (isFirstSearchRender.current) {
      isFirstSearchRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      startSearchTransition(() => {
        // Carry the rest of the URL through. Typing in the search box
        // used to build a fresh query string, which silently dropped the
        // active filter chips and (once sorting existed) the sort mode —
        // the list would reorder itself under the user mid-keystroke.
        const params = new URLSearchParams(searchParamsRef.current.toString());
        const trimmed = search.trim();
        if (trimmed) params.set('q', trimmed);
        else params.delete('q');
        // Reset the cursor — a cursor anchored to the previous result set
        // is meaningless once the search term changes.
        params.delete('cursor');
        if (pageSize !== 50) params.set('size', String(pageSize));
        const qs = params.toString();
        router.replace(`/dashboard/companies${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router, pageSize]);

  function handleCreate(formData: FormData) {
    setCreateError(null);
    setCreateFieldErrors({});

    const name = String(formData.get('name') ?? '').trim();
    const domain = String(formData.get('domain') ?? '').trim();
    const industry = String(formData.get('industry') ?? '').trim();

    const draft: CompanyItem = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      name: name || '(unnamed)',
      domain: domain || null,
      industry: industry || null,
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: null,
      customFields: {},
      deletedAt: null,
      deletedBy: null,
      normalizedName: null,
      mergedIntoId: null,
      dedupOverride: false,
      // A company that does not exist yet has no deals, no contacts and no
      // history. Zeroes here are the truth, not a placeholder — and they
      // render as em dashes, so the optimistic row looks the way the real
      // row will a moment later.
      rollup: EMPTY_COMPANY_ROLLUP,
      __pending: true,
    };

    startCreateTransition(async () => {
      applyOptimistic({ type: 'create', draft });
      const result = await createCompanyAction(formData);
      if (!result.ok) {
        setCreateError(result.message);
        setCreateFieldErrors(result.fieldErrors ?? {});
      } else {
        setCreateResetKey((k) => k + 1);
      }
    });
  }

  function handleEditSubmit(formData: FormData) {
    if (!editingCompany) return;
    setEditError(null);
    setEditFieldErrors({});

    const name = String(formData.get('name') ?? '').trim();
    const domain = String(formData.get('domain') ?? '').trim();
    const industry = String(formData.get('industry') ?? '').trim();

    const draft: CompanyItem = {
      ...editingCompany,
      name: name || editingCompany.name,
      domain: domain || null,
      industry: industry || null,
      updatedAt: new Date(),
    };

    startEditTransition(async () => {
      applyOptimistic({ type: 'update', draft });
      const result = await updateCompanyAction(formData);
      if (!result.ok) {
        setEditError(result.message);
        setEditFieldErrors(result.fieldErrors ?? {});
      } else {
        setEditingCompany(null);
      }
    });
  }

  function handleDelete(company: Company) {
    setActionError(null);
    startDeleteTransition(async () => {
      applyOptimistic({ type: 'remove', id: company.id });
      const result = await softDeleteCompanyAction(company.id);
      if (!result.ok) setActionError(result.message);
    });
  }

  function handleDeleteFromDrawer() {
    if (!editingCompany) return;
    handleDelete(editingCompany);
    setEditingCompany(null);
  }

  // ---- Inline cell editing (click-to-edit) ----
  function fieldValue(c: CompanyItem, field: CompanyField): string {
    return (c[field] ?? '') as string;
  }
  function runCompanyPatch(
    id: string,
    field: CompanyField,
    raw: string,
    onUndo?: () => void,
  ) {
    const value = raw.trim() ? raw.trim() : null;
    startEditTransition(async () => {
      applyOptimistic({ type: 'patch', id, patch: { [field]: value } as Partial<CompanyItem> });
      const res = await patchCompanyAction({ id, [field]: value });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      if (onUndo) toast.success('Updated', { action: { label: 'Undo', onClick: onUndo } });
    });
  }
  function commitField(company: CompanyItem, field: CompanyField, raw: string) {
    const prev = fieldValue(company, field);
    if (raw.trim() === prev.trim()) return;
    runCompanyPatch(company.id, field, raw, () =>
      runCompanyPatch(company.id, field, prev),
    );
  }

  // ---- Multi-select + bulk ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const selectableIds = optimisticItems
    .filter((c) => !c.id.startsWith('optimistic-'))
    .map((c) => c.id);
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

  function bulkOwner(ownerId: string | null) {
    const ids = [...selectedIds];
    startBulkTransition(async () => {
      for (const id of ids) applyOptimistic({ type: 'patch', id, patch: { ownerId } });
      const results = await Promise.all(ids.map((id) => patchCompanyAction({ id, ownerId })));
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`Reassigned ${ok} compan${ok > 1 ? 'ies' : 'y'}`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be reassigned`);
    });
  }

  function bulkDelete() {
    const ids = [...selectedIds];
    if (!window.confirm(`Delete ${ids.length} compan${ids.length > 1 ? 'ies' : 'y'}? They can be restored from Recently deleted.`)) {
      return;
    }
    startBulkTransition(async () => {
      for (const id of ids) applyOptimistic({ type: 'remove', id });
      const results = await Promise.all(ids.map((id) => softDeleteCompanyAction(id)));
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} compan${ok > 1 ? 'ies' : 'y'} deleted`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be deleted`);
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
              placeholder="Search companies by name…"
              aria-label="Search companies by name"
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
              label="New company"
              drawerTitle="Add company"
              description="Companies in this tenant."
              closeOnSuccessKey={createResetKey}
            >
              {() => (
                <CreateCompanyForm
                  onSubmit={handleCreate}
                  pending={createPending}
                  error={createError}
                  fieldErrors={createFieldErrors}
                  resetKey={createResetKey}
                  teammates={teammates}
                  currentUserId={currentUserId}
                  customFieldDefs={customFieldDefs}
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

        {/*
          Every chip below now filters on a column the table renders, so
          the result set is checkable from the screen: "Has active deals"
          leaves no row without a Stage badge, and Recently active / Stale
          partition the same Last Activity value at the same threshold.
          The titles say which column, because a chip whose rule you have
          to guess is a chip you stop trusting.

          `alsoClear` hands "Clear all" the sort keys too — a cleared
          filter set that stayed sorted by pipeline is not the unfiltered
          list the button promises.
        */}
        <ToggleFilterBar
          basePath="/dashboard/companies"
          alsoClear={[...COMPANY_SORT_URL_KEYS]}
          toggles={[
            { key: 'mine', label: 'My companies', title: 'Companies you own' },
            { key: 'unassigned', label: 'Unassigned', title: 'No owner assigned' },
            { key: 'hasDeals', label: 'Has active deals', title: 'Deals column counts at least one open deal' },
            { key: 'recentActivityDays', value: '14', label: 'Recently active', title: 'Last Activity within 14 days' },
            { key: 'createdWithinDays', value: '30', label: 'New (30d)', title: 'Created in the last 30 days' },
            { key: 'stale', label: 'Stale', title: 'Last Activity older than 30 days (or never)' },
          ]}
        />

        {actionError ? (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </p>
        ) : null}

        {(canEdit || canDelete) && selectedIds.size > 0 ? (
          <BulkActionBar
            count={selectedIds.size}
            pending={bulkPending}
            currentUserId={currentUserId}
            assignable={canEdit ? teammates : undefined}
            onAssignOwner={canEdit ? bulkOwner : undefined}
            onDelete={canDelete ? bulkDelete : undefined}
            onClear={clearSelection}
          />
        ) : null}

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <CompaniesTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              selectable={canEdit || canDelete}
              selectedIds={selectedIds}
              allSelected={allSelected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onEdit={(c) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingCompany(c);
              }}
              onDelete={handleDelete}
              onPatchField={commitField}
              deletePending={deletePending}
              sort={sort}
              dir={dir}
              onSort={pushSort}
              currencyContext={currencyContext}
            />
            <PaginationControls
              basePath="/dashboard/companies"
              nextCursor={nextCursor}
              size={pageSize}
              visibleCount={optimisticItems.length}
            />
          </div>
        )}
      </section>

      <EditCompanyDrawer
        open={editingCompany !== null}
        onClose={() => setEditingCompany(null)}
        company={editingCompany}
        customFieldDefs={customFieldDefs}
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

function CompaniesTable({
  items,
  canEdit,
  canDelete,
  selectable,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onEdit,
  onDelete,
  onPatchField,
  deletePending,
  sort,
  dir,
  onSort,
  currencyContext,
}: {
  items: CompanyItem[];
  canEdit: boolean;
  canDelete: boolean;
  selectable: boolean;
  selectedIds: Set<string>;
  allSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (company: CompanyItem) => void;
  onDelete: (company: Company) => void;
  onPatchField: (company: CompanyItem, field: CompanyField, raw: string) => void;
  deletePending: boolean;
  sort: CompanySort;
  dir: SortDir;
  onSort: (next: CompanySort) => void;
  currencyContext: TenantCurrencyContext;
}) {
  const showActions = canEdit || canDelete;
  /**
   * `aria-sort` belongs on the `th`, not on the button inside it, and only
   * ONE column may carry it — that is how a screen reader announces which
   * column the table is currently ordered by.
   */
  const ariaSortFor = (key: CompanySort) =>
    sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined;

  return (
    <HorizontalScroller>
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-[0.06em] text-slate-500">
            <tr>
              {/*
                The Name column is frozen. Eleven columns do not fit on one
                screen, and a horizontally scrolled table whose identity
                column has scrolled away is a grid of numbers with no
                subjects — you can read "₹52,00,000 open" and have no way to
                learn whose. z-20 puts it above the sticky header row it
                crosses; the shadow (not a border) marks the seam, because
                a border on a sticky cell disappears under
                `border-collapse: collapse`.
              */}
              <th
                scope="col"
                className={cn(STICKY_NAME_CELL, 'z-20 bg-slate-50 px-3 py-2 text-left font-medium')}
              >
                <span className="flex items-center gap-2">
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={onToggleSelectAll}
                      aria-label="Select all companies"
                      className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  ) : null}
                  Name
                </span>
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium sm:table-cell"
              >
                Domain
              </th>
              {/*
                Industry moved from `md` to `xl`. It is a static label; the
                six rollup columns beside it are the reason someone opened
                this page. When the viewport can only hold some of them,
                the ones that change are worth more than the one that does
                not.
              */}
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium xl:table-cell"
              >
                Industry
              </th>
              <th
                scope="col"
                aria-sort={ariaSortFor('deals')}
                className="hidden px-3 py-2 text-right font-medium lg:table-cell"
              >
                <SortButton
                  label="Deals"
                  active={sort === 'deals'}
                  dir={dir}
                  onClick={() => onSort('deals')}
                />
              </th>
              {/*
                Open Pipeline and Won share one column because eleven
                columns do not fit and these two are read together: "what
                is live here" over "what this account has ever been worth".
                They stay two INDEPENDENT sort keys — hence two buttons,
                stacked to mirror the two lines in the cell below.
              */}
              <th
                scope="col"
                aria-sort={ariaSortFor(
                  sort === 'won' ? 'won' : 'pipeline',
                )}
                className="px-3 py-2 text-right font-medium"
              >
                <div className="flex flex-col items-end gap-0.5">
                  <span>Value</span>
                  <span className="flex items-center gap-1 normal-case tracking-normal">
                    <SortButton
                      label="open"
                      active={sort === 'pipeline'}
                      dir={dir}
                      onClick={() => onSort('pipeline')}
                      title="Sort by open pipeline"
                    />
                    <span aria-hidden className="text-slate-300">
                      ·
                    </span>
                    <SortButton
                      label="won"
                      active={sort === 'won'}
                      dir={dir}
                      onClick={() => onSort('won')}
                      title="Sort by won lifetime value"
                    />
                  </span>
                </div>
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium md:table-cell"
              >
                Stage
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right font-medium xl:table-cell"
              >
                Contacts
              </th>
              <th
                scope="col"
                aria-sort={ariaSortFor('activity')}
                className="hidden px-3 py-2 text-right font-medium md:table-cell"
              >
                <SortButton
                  label="Last activity"
                  active={sort === 'activity'}
                  dir={dir}
                  onClick={() => onSort('activity')}
                />
              </th>
              <th
                scope="col"
                aria-sort={ariaSortFor('recent')}
                className="hidden px-3 py-2 text-right font-medium lg:table-cell"
              >
                <SortButton
                  label="Created"
                  active={sort === 'recent'}
                  dir={dir}
                  onClick={() => onSort('recent')}
                />
              </th>
              {showActions ? (
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {items.map((c) => (
              <tr
                key={c.id}
                className={cn('transition-opacity', c.__pending && 'opacity-60')}
              >
                <td className={cn(STICKY_NAME_CELL, 'z-10 bg-white px-3 py-2 font-medium')}>
                  <div className="flex items-center gap-2">
                    {selectable && !c.id.startsWith('optimistic-') ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => onToggleSelect(c.id)}
                        aria-label={`Select ${c.name}`}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <InlineEditCell
                        ariaLabel="company name"
                        disabled={!canEdit || c.__pending === true}
                        value={c.name}
                        onCommit={(v) => onPatchField(c, 'name', v)}
                      />
                    </div>
                    {/*
                      The name cell is an inline editor, so unlike the deals
                      table the text itself cannot double as the link — a
                      click has to land in the input. This icon is the row's
                      only door to the account view; without it the page is
                      reachable only from search and the activity feed.
                    */}
                    {c.id.startsWith('optimistic-') ? null : (
                      <HoverPrefetchLink
                        href={`/dashboard/companies/${c.id}`}
                        aria-label={`Open ${c.name}`}
                        title={`Open ${c.name}`}
                        className="shrink-0 rounded p-0.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600 focus:text-slate-600"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </HoverPrefetchLink>
                    )}
                  </div>
                </td>
                <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">
                  <InlineEditCell
                    ariaLabel="domain"
                    placeholder="—"
                    disabled={!canEdit || c.__pending === true}
                    value={c.domain ?? ''}
                    onCommit={(v) => onPatchField(c, 'domain', v)}
                  />
                </td>
                <td className="hidden px-3 py-2 text-slate-600 xl:table-cell">
                  <InlineEditCell
                    ariaLabel="industry"
                    placeholder="—"
                    disabled={!canEdit || c.__pending === true}
                    value={c.industry ?? ''}
                    onCommit={(v) => onPatchField(c, 'industry', v)}
                  />
                </td>
                {/*
                  Deals is the TOTAL, and the tooltip splits it. Showing
                  only the open count would make the column disagree with
                  the account's own Deals panel, which lists won and lost
                  deals too; showing only the total would hide why an
                  account with three deals shows no Stage badge.
                */}
                <td
                  className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700 lg:table-cell"
                  title={dealsTitle(c.rollup)}
                >
                  {formatCount(c.rollup.dealCount)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <ValueCell rollup={c.rollup} ctx={currencyContext} />
                </td>
                <td className="hidden px-3 py-2 md:table-cell">
                  {c.rollup.topStage ? (
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
                        STAGE_BADGE_STYLES[c.rollup.topStage],
                      )}
                      title="Stage of the most recently updated open deal"
                    >
                      {DEAL_STAGE_LABELS[c.rollup.topStage]}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700 xl:table-cell">
                  {formatCount(c.rollup.contactCount)}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 md:table-cell">
                  {c.rollup.lastActivityAt ? (
                    <RelativeTime date={c.rollup.lastActivityAt} />
                  ) : (
                    <span className="text-slate-300" title="Never touched">
                      —
                    </span>
                  )}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 lg:table-cell">
                  {dateFormatter.format(new Date(c.createdAt))}
                </td>
                {showActions ? (
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <RowActions
                      canEdit={canEdit}
                      canDelete={canDelete}
                      onEdit={() => onEdit(c)}
                      onDelete={() => onDelete(c)}
                      busy={deletePending && c.__pending === true}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
        </tbody>
      </table>
    </HorizontalScroller>
  );
}

/**
 * Shared by the Name header cell and every Name body cell so the two
 * cannot drift apart and leave the column half-frozen.
 *
 * The right edge is a `box-shadow`, not a `border-right`: under
 * `border-collapse: collapse` a sticky cell's own borders are painted with
 * the (non-sticky) table grid and slide away underneath it. A shadow is
 * painted with the cell.
 */
const STICKY_NAME_CELL =
  'sticky left-0 shadow-[1px_0_0_0_rgb(226_232_240)]';

/**
 * A horizontally scrollable region with a scrollbar at the TOP as well as
 * the bottom.
 *
 * The problem it fixes: a wide table's only scrollbar sits under its last
 * row, so reading the right-hand columns of row 3 of 50 means scrolling
 * all the way down to find the bar, dragging it, and scrolling back up.
 * The browser gives you no way to move a scrollbar, so the top bar is a
 * second empty scroller of the same width with its scroll position bound
 * to the real one.
 *
 * It renders only when the content actually overflows — a permanent
 * scrollbar above a table that fits is furniture, not a control.
 */
function HorizontalScroller({ children }: { children: React.ReactNode }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      setContentWidth(body.scrollWidth);
      // The 1px slack absorbs sub-pixel layout rounding, which otherwise
      // flickers the bar in and out at the exact fitting width.
      setOverflowing(body.scrollWidth > body.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    // The table itself, not just the viewport: a column that grows when a
    // longer company name loads changes scrollWidth without resizing the
    // scroll container.
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);

  /**
   * Mirror the scroll position both ways. The guard is what stops the two
   * `onScroll` handlers from driving each other forever — one write per
   * gesture, then the flag clears on the next frame.
   *
   * The moving strip is read off `event.currentTarget`, never off its own
   * ref: only the strip being written to has to be looked up, which keeps
   * these honest event handlers rather than functions that reach for a ref
   * and could be called from anywhere.
   */
  const syncing = useRef(false);

  function syncFromTop(event: React.UIEvent<HTMLDivElement>) {
    if (syncing.current) return;
    const body = bodyRef.current;
    if (!body) return;
    syncing.current = true;
    body.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  function syncFromBody(event: React.UIEvent<HTMLDivElement>) {
    if (syncing.current) return;
    const top = topRef.current;
    if (!top) return;
    syncing.current = true;
    top.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  return (
    <div>
      <div
        ref={topRef}
        onScroll={syncFromTop}
        aria-hidden
        className={cn(
          'overflow-x-auto overflow-y-hidden',
          overflowing ? 'block' : 'hidden',
        )}
      >
        {/* Zero-height content of the table's width: enough for the
            browser to give the strip a scrollbar, nothing to look at. */}
        <div style={{ width: contentWidth, height: 1 }} />
      </div>
      <div ref={bodyRef} onScroll={syncFromBody} className="overflow-x-auto">
        {children}
      </div>
    </div>
  );
}

/**
 * A column header that sorts. Always a `<button>` inside the `<th>`, never
 * a click handler on the `th` itself: the header has to be reachable and
 * operable from the keyboard, and only a real button gives that for free.
 *
 * The icon states are three, not two, and the third is the point — an
 * inactive column shows a neutral double chevron so it reads as "you can
 * sort by this", where a blank header reads as "this column is decoration".
 */
function SortButton({
  label,
  active,
  dir,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  title?: string;
}) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        title ??
        (active
          ? `Sorted ${dir === 'asc' ? 'ascending' : 'descending'} — click to ${dir === 'asc' ? 'reset' : 'reverse'}`
          : `Sort by ${label.toLowerCase()}`)
      }
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-slate-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40',
        active ? 'text-indigo-700' : 'text-slate-500',
      )}
    >
      {label}
      <Icon
        className={cn('h-3 w-3', active ? 'opacity-100' : 'opacity-40')}
        aria-hidden
      />
    </button>
  );
}

/** Tooltip for the Deals cell: the total, and how it splits. */
function dealsTitle(r: CompanyRollupFields): string {
  if (r.dealCount === 0) return 'No deals';
  const closedLost = r.dealCount - r.openDealCount - r.wonDealCount;
  const parts = [`${r.openDealCount} open`, `${r.wonDealCount} won`];
  if (closedLost > 0) parts.push(`${closedLost} lost`);
  return `${r.dealCount} deal${r.dealCount === 1 ? '' : 's'} — ${parts.join(', ')}`;
}

/**
 * Open pipeline over won lifetime value, in one column.
 *
 * The distinction the two lines exist to draw:
 *
 *   ₹4.2L open   an account being worked right now
 *   ₹12L won     …that has also closed business before
 *
 *   — open       nothing live
 *   ₹12L won     …but a real customer. Not a dead account.
 *
 *   — open
 *   — won        a dead account, and it should look like one.
 *
 * A zero would collapse the second and third cases into the same
 * grey row, which is precisely the row a rep needs to tell apart.
 *
 * `₹0 open` is a fourth, deliberate state: open deals exist and none of
 * them carries an amount yet. That is a data-entry gap, not an empty
 * account, and it is the only case where a zero is printed.
 *
 * Compact or not follows the workspace's own number preference; the
 * tooltip always carries the exact figure, because a column that only
 * ever says "₹12L" cannot be reconciled against anything.
 */
function ValueCell({
  rollup,
  ctx,
}: {
  rollup: CompanyRollupFields;
  ctx: TenantCurrencyContext;
}) {
  const open = hasOpenPipeline(rollup);
  const won = hasWonValue(rollup);
  const exact = [
    open
      ? `${formatTenantCurrency(rollup.openPipelineValue, ctx)} open pipeline`
      : 'No open deals',
    won
      ? `${formatTenantCurrency(rollup.wonLifetimeValue, ctx)} won lifetime`
      : 'Nothing won',
  ].join(' · ');

  return (
    <span className="inline-flex flex-col items-end leading-tight" title={exact}>
      <span className="tabular-nums text-slate-800">
        {open ? (
          formatCompactTenantCurrency(rollup.openPipelineValue, ctx)
        ) : (
          <span className="text-slate-300">—</span>
        )}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-slate-400">
          open
        </span>
      </span>
      <span className="text-[11px] tabular-nums text-slate-500">
        {won ? (
          formatCompactTenantCurrency(rollup.wonLifetimeValue, ctx)
        ) : (
          <span className="text-slate-300">—</span>
        )}
        <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">
          won
        </span>
      </span>
    </span>
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
