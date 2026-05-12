'use client';

import { Loader2, Pencil, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';

import type { Company, MembershipRole } from '@/db/schema';
import type { PageSize } from '@/lib/pagination/page-size';
import { canDeleteCompanies, canManageCompanies } from '@/lib/rbac';
import { cn } from '@/lib/utils';

import { CreateDrawer } from '../../_components/create-drawer';
import { PaginationControls } from '../../_components/pagination-controls';
import {
  createCompanyAction,
  softDeleteCompanyAction,
  updateCompanyAction,
} from '../actions';
import { CreateCompanyForm } from './create-company-form';
import { EditCompanyDrawer } from './edit-company-drawer';
import { EmptyState } from './empty-state';

type CompanyItem = Company & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: CompanyItem }
  | { type: 'update'; draft: CompanyItem }
  | { type: 'remove'; id: string };

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function CompaniesView({
  initialItems,
  initialSearch,
  currentRole,
  nextCursor,
  pageSize,
}: {
  initialItems: Company[];
  initialSearch: string;
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
}) {
  const router = useRouter();
  const canEdit = canManageCompanies(currentRole);
  const canDelete = canDeleteCompanies(currentRole);

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
        case 'remove':
          return state.filter((item) => item.id !== op.id);
      }
    },
  );

  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string[]>>({});
  const [createResetKey, setCreateResetKey] = useState(0);

  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
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
        // Preserve page size, but reset cursor — a cursor anchored to
        // the previous result set is meaningless after the filter
        // changes.
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
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
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
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

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
            <CompaniesTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={(c) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingCompany(c);
              }}
              onDelete={handleDelete}
              deletePending={deletePending}
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
  onEdit,
  onDelete,
  deletePending,
}: {
  items: CompanyItem[];
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (company: Company) => void;
  onDelete: (company: Company) => void;
  deletePending: boolean;
}) {
  const showActions = canEdit || canDelete;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="sticky top-0 z-10 bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Name
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium sm:table-cell"
              >
                Domain
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium md:table-cell"
              >
                Industry
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right font-medium sm:table-cell"
              >
                Created
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
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">
                  {c.domain ?? '—'}
                </td>
                <td className="hidden px-3 py-2 text-slate-600 md:table-cell">
                  {c.industry ?? '—'}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 sm:table-cell">
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
