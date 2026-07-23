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
import { toast } from 'sonner';

import type { Contact, MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactRow } from '@/lib/contacts/queries';
import type { CustomFieldDef } from '@/lib/custom-fields/types';
import type { PageSize } from '@/lib/pagination/page-size';
import { canDeleteContacts, canManageContacts } from '@/lib/rbac';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { BulkActionBar } from '../../_components/bulk-action-bar';
import { CreateDrawer } from '../../_components/create-drawer';
import { InlineEditCell } from '../../_components/inline-edit-cell';
import { ToggleFilterBar } from '../../_components/toggle-filter-bar';
import { PaginationControls } from '../../_components/pagination-controls';
import {
  createContactAction,
  patchContactAction,
  softDeleteContactAction,
  updateContactAction,
} from '../actions';

type ContactField = 'email' | 'title' | 'phone';
import { CreateContactForm } from './create-contact-form';
import { EditContactDrawer } from './edit-contact-drawer';
import { EmptyState } from './empty-state';

type ContactItem = ContactRow & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: ContactItem }
  | { type: 'update'; draft: ContactItem }
  | { type: 'patch'; id: string; patch: Partial<ContactItem> }
  | { type: 'remove'; id: string };

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function displayName(c: ContactRow): string {
  const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return c.email ?? '(unnamed)';
}

export function ContactsView({
  initialItems,
  initialSearch,
  companyOptions,
  teammates,
  currentUserId,
  currentRole,
  nextCursor,
  pageSize,
  customFieldDefs,
}: {
  initialItems: ContactRow[];
  initialSearch: string;
  companyOptions: CompanyOption[];
  teammates: Teammate[];
  currentUserId: string;
  customFieldDefs: CustomFieldDef[];
  currentRole: MembershipRole;
  nextCursor: string | null;
  pageSize: PageSize;
}) {
  const router = useRouter();
  const canEdit = canManageContacts(currentRole);
  const canDelete = canDeleteContacts(currentRole);

  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();
  const [editPending, startEditTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();

  const [optimisticItems, applyOptimistic] = useOptimistic<ContactItem[], OptimisticOp>(
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

  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
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
        router.replace(`/dashboard/contacts${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router, pageSize]);

  function handleCreate(formData: FormData) {
    setCreateError(null);
    setCreateFieldErrors({});

    const firstName = String(formData.get('firstName') ?? '').trim();
    const lastName = String(formData.get('lastName') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();
    const title = String(formData.get('title') ?? '').trim();
    const companyId = String(formData.get('companyId') ?? '').trim() || null;
    const companyName = companyId
      ? companyOptions.find((c) => c.id === companyId)?.name ?? null
      : null;

    const draft: ContactItem = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      companyId,
      companyName,
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      title: title || null,
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
      __pending: true,
    };

    startCreateTransition(async () => {
      applyOptimistic({ type: 'create', draft });
      const result = await createContactAction(formData);
      if (!result.ok) {
        setCreateError(result.message);
        setCreateFieldErrors(result.fieldErrors ?? {});
      } else {
        setCreateResetKey((k) => k + 1);
      }
    });
  }

  function handleEditSubmit(formData: FormData) {
    if (!editingContact) return;
    setEditError(null);
    setEditFieldErrors({});

    const firstName = String(formData.get('firstName') ?? '').trim();
    const lastName = String(formData.get('lastName') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();
    const title = String(formData.get('title') ?? '').trim();
    const companyId = String(formData.get('companyId') ?? '').trim() || null;
    const companyName = companyId
      ? companyOptions.find((c) => c.id === companyId)?.name ?? null
      : null;

    const draft: ContactItem = {
      ...editingContact,
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      title: title || null,
      companyId,
      companyName,
      updatedAt: new Date(),
    };

    startEditTransition(async () => {
      applyOptimistic({ type: 'update', draft });
      const result = await updateContactAction(formData);
      if (!result.ok) {
        setEditError(result.message);
        setEditFieldErrors(result.fieldErrors ?? {});
      } else {
        setEditingContact(null);
      }
    });
  }

  function handleDelete(contact: ContactRow) {
    setActionError(null);
    startDeleteTransition(async () => {
      applyOptimistic({ type: 'remove', id: contact.id });
      const result = await softDeleteContactAction(contact.id);
      if (!result.ok) setActionError(result.message);
    });
  }

  function handleDeleteFromDrawer() {
    if (!editingContact) return;
    handleDelete(editingContact);
    setEditingContact(null);
  }

  // ---- Inline cell editing (click-to-edit) ----
  function runContactPatch(
    id: string,
    field: ContactField,
    raw: string,
    onUndo?: () => void,
  ) {
    const value = raw.trim() ? raw.trim() : null;
    startEditTransition(async () => {
      applyOptimistic({ type: 'patch', id, patch: { [field]: value } as Partial<ContactItem> });
      const res = await patchContactAction({ id, [field]: value });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      if (onUndo) toast.success('Updated', { action: { label: 'Undo', onClick: onUndo } });
    });
  }
  function commitField(contact: ContactItem, field: ContactField, raw: string) {
    const prev = (contact[field] ?? '') as string;
    if (raw.trim() === prev.trim()) return;
    runContactPatch(contact.id, field, raw, () =>
      runContactPatch(contact.id, field, prev),
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
      const results = await Promise.all(ids.map((id) => patchContactAction({ id, ownerId })));
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`Reassigned ${ok} contact${ok > 1 ? 's' : ''}`);
      const failed = results.length - ok;
      if (failed) toast.error(`${failed} couldn't be reassigned`);
    });
  }

  function bulkDelete() {
    const ids = [...selectedIds];
    if (!window.confirm(`Delete ${ids.length} contact${ids.length > 1 ? 's' : ''}? They can be restored from Recently deleted.`)) {
      return;
    }
    startBulkTransition(async () => {
      for (const id of ids) applyOptimistic({ type: 'remove', id });
      const results = await Promise.all(ids.map((id) => softDeleteContactAction(id)));
      clearSelection();
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} contact${ok > 1 ? 's' : ''} deleted`);
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
              placeholder="Search by name, email, or title…"
              aria-label="Search contacts"
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
              label="New contact"
              drawerTitle="Add contact"
              description="One name, email, or both — at least one is required."
              closeOnSuccessKey={createResetKey}
            >
              {() => (
                <CreateContactForm
                  onSubmit={handleCreate}
                  pending={createPending}
                  error={createError}
                  fieldErrors={createFieldErrors}
                  resetKey={createResetKey}
                  companyOptions={companyOptions}
                  teammates={teammates}
                  currentUserId={currentUserId}
                  customFieldDefs={customFieldDefs}
                />
              )}
            </CreateDrawer>
          ) : null}
        </div>

        <ToggleFilterBar
          basePath="/dashboard/contacts"
          toggles={[
            { key: 'mine', label: 'My contacts', title: 'Contacts you own' },
            { key: 'unassigned', label: 'Unassigned', title: 'No owner assigned' },
            { key: 'recentActivityDays', value: '14', label: 'Recently active', title: 'Activity in the last 14 days' },
            { key: 'noCompany', label: 'No company', title: 'Contacts not linked to a company' },
            { key: 'createdWithinDays', value: '30', label: 'New (30d)', title: 'Created in the last 30 days' },
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
            <ContactsTable
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
                setEditingContact(c);
              }}
              onDelete={handleDelete}
              onPatchField={commitField}
              deletePending={deletePending}
            />
            <PaginationControls
              basePath="/dashboard/contacts"
              nextCursor={nextCursor}
              size={pageSize}
              visibleCount={optimisticItems.length}
            />
          </div>
        )}
      </section>

      <EditContactDrawer
        open={editingContact !== null}
        onClose={() => setEditingContact(null)}
        contact={editingContact}
        companyOptions={companyOptions}
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

function ContactsTable({
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
}: {
  items: ContactItem[];
  canEdit: boolean;
  canDelete: boolean;
  selectable: boolean;
  selectedIds: Set<string>;
  allSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onEdit: (contact: ContactRow) => void;
  onDelete: (contact: ContactRow) => void;
  onPatchField: (contact: ContactItem, field: ContactField, raw: string) => void;
  deletePending: boolean;
}) {
  const showActions = canEdit || canDelete;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="sticky top-0 z-10 bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                <span className="flex items-center gap-2">
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={onToggleSelectAll}
                      aria-label="Select all contacts"
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
                Email
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium md:table-cell"
              >
                Title
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium md:table-cell"
              >
                Company
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
                <td className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    {selectable && !c.id.startsWith('optimistic-') ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => onToggleSelect(c.id)}
                        aria-label={`Select ${displayName(c)}`}
                        className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                  <div className="font-medium">{displayName(c)}</div>
                  <span className="text-xs text-slate-500">
                    <InlineEditCell
                      ariaLabel="phone"
                      type="text"
                      placeholder="+ phone"
                      disabled={!canEdit || c.__pending === true}
                      value={c.phone ?? ''}
                      onCommit={(v) => onPatchField(c, 'phone', v)}
                    />
                  </span>
                    </div>
                  </div>
                </td>
                <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">
                  <InlineEditCell
                    ariaLabel="email"
                    type="text"
                    placeholder="+ email"
                    disabled={!canEdit || c.__pending === true}
                    value={c.email ?? ''}
                    onCommit={(v) => onPatchField(c, 'email', v)}
                  />
                </td>
                <td className="hidden px-3 py-2 text-slate-600 md:table-cell">
                  <InlineEditCell
                    ariaLabel="title"
                    placeholder="—"
                    disabled={!canEdit || c.__pending === true}
                    value={c.title ?? ''}
                    onCommit={(v) => onPatchField(c, 'title', v)}
                  />
                </td>
                <td className="hidden px-3 py-2 text-slate-600 md:table-cell">
                  {c.companyName ?? '—'}
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
