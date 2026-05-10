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

import type { Contact, MembershipRole } from '@/db/schema';
import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactRow } from '@/lib/contacts/queries';
import type { PageSize } from '@/lib/pagination/cursor';
import { canDeleteContacts, canManageContacts } from '@/lib/rbac';
import { cn } from '@/lib/utils';

import { PaginationControls } from '../../_components/pagination-controls';
import {
  createContactAction,
  softDeleteContactAction,
  updateContactAction,
} from '../actions';
import { CreateContactForm } from './create-contact-form';
import { EditContactDrawer } from './edit-contact-drawer';
import { EmptyState } from './empty-state';

type ContactItem = ContactRow & { __pending?: boolean };

type OptimisticOp =
  | { type: 'create'; draft: ContactItem }
  | { type: 'update'; draft: ContactItem }
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
  currentRole,
  nextCursor,
  pageSize,
}: {
  initialItems: ContactRow[];
  initialSearch: string;
  companyOptions: CompanyOption[];
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
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
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

  const showEmpty = optimisticItems.length === 0;
  const trimmedSearch = search.trim();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <section className="flex flex-col gap-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or title…"
            aria-label="Search contacts"
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
            <ContactsTable
              items={optimisticItems}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={(c) => {
                setEditError(null);
                setEditFieldErrors({});
                setEditingContact(c);
              }}
              onDelete={handleDelete}
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

      <aside>
        {canEdit ? (
          <CreateContactForm
            onSubmit={handleCreate}
            pending={createPending}
            error={createError}
            fieldErrors={createFieldErrors}
            resetKey={createResetKey}
            companyOptions={companyOptions}
          />
        ) : null}
      </aside>

      <EditContactDrawer
        open={editingContact !== null}
        onClose={() => setEditingContact(null)}
        contact={editingContact}
        companyOptions={companyOptions}
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
  onEdit,
  onDelete,
  deletePending,
}: {
  items: ContactItem[];
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (contact: ContactRow) => void;
  onDelete: (contact: ContactRow) => void;
  deletePending: boolean;
}) {
  const showActions = canEdit || canDelete;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Name
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium sm:table-cell"
              >
                Email
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium md:table-cell"
              >
                Title
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium md:table-cell"
              >
                Company
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-right font-medium sm:table-cell"
              >
                Created
              </th>
              {showActions ? (
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((c) => (
              <tr
                key={c.id}
                className={cn('transition-opacity', c.__pending && 'opacity-60')}
              >
                <td className="px-4 py-3">
                  <div className="font-medium">{displayName(c)}</div>
                  {c.phone ? (
                    <div className="text-xs text-zinc-500">{c.phone}</div>
                  ) : null}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 sm:table-cell dark:text-zinc-400">
                  {c.email ?? '—'}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 md:table-cell dark:text-zinc-400">
                  {c.title ?? '—'}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 md:table-cell dark:text-zinc-400">
                  {c.companyName ?? '—'}
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-right text-xs text-zinc-500 sm:table-cell">
                  {dateFormatter.format(new Date(c.createdAt))}
                </td>
                {showActions ? (
                  <td className="whitespace-nowrap px-4 py-3 text-right">
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
