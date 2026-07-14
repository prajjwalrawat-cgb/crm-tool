'use client';

import {
  AlertCircle,
  Loader2,
  Mail,
  Phone,
  Plus,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { DealContactRole } from '@/db/schema';
import type { ContactOption } from '@/lib/contacts/queries';
import {
  DEAL_CONTACT_ROLE_LABELS,
  dealContactName,
  type DealContactRow,
} from '@/lib/deals/contact-shared';
import { cn } from '@/lib/utils';

import {
  addDealContactAction,
  createAndLinkContactAction,
  removeDealContactAction,
  setPrimaryDealContactAction,
  updateDealContactRoleAction,
} from '../contact-actions';

const ROLE_BADGE: Record<DealContactRole, string> = {
  decision_maker: 'bg-indigo-100 text-indigo-700',
  champion: 'bg-emerald-100 text-emerald-700',
  influencer: 'bg-sky-100 text-sky-700',
  blocker: 'bg-rose-100 text-rose-700',
  other: 'bg-slate-100 text-slate-600',
};

const ROLES: DealContactRole[] = [
  'decision_maker',
  'influencer',
  'champion',
  'blocker',
  'other',
];

type Mode = 'closed' | 'existing' | 'new';

export function DealContactsCard({
  dealId,
  initialContacts,
  contactOptions,
  canEdit,
  showEmptyWarning,
}: {
  dealId: string;
  initialContacts: DealContactRow[];
  contactOptions: ContactOption[];
  canEdit: boolean;
  /** Deal is Proposal-stage-or-later — flag the missing-stakeholder gap. */
  showEmptyWarning: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('closed');
  const [pending, startTransition] = useTransition();

  const linkedIds = new Set(initialContacts.map((c) => c.contactId));
  const available = contactOptions.filter((c) => !linkedIds.has(c.id));

  function run(fn: () => Promise<{ ok: boolean; message?: string }>, success?: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.error(result.message ?? 'Something went wrong');
        return;
      }
      if (success) toast.success(success);
      setMode('closed');
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Stakeholders
          </span>
        </div>
        {canEdit && mode === 'closed' ? (
          <button
            type="button"
            onClick={() => setMode('existing')}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
          >
            <Plus className="h-3 w-3" aria-hidden />
            Add
          </button>
        ) : null}
      </div>

      {initialContacts.length === 0 && mode === 'closed' ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-2 py-3 text-[11.5px] text-slate-500">
          No stakeholders linked yet.
        </p>
      ) : null}

      {showEmptyWarning && initialContacts.length === 0 ? (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-600">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          This deal is in Proposal or later with no contacts — add the people
          who decide.
        </p>
      ) : null}

      {initialContacts.length > 0 ? (
        <ul className="flex flex-col divide-y divide-slate-100">
          {initialContacts.map((c) => (
            <li key={c.id} className="flex items-start gap-2 py-2">
              {canEdit ? (
                <button
                  type="button"
                  aria-label={c.isPrimary ? 'Primary contact' : 'Make primary'}
                  disabled={pending || c.isPrimary}
                  onClick={() =>
                    run(
                      () =>
                        setPrimaryDealContactAction({ id: c.id, dealId }),
                      'Primary contact updated',
                    )
                  }
                  className="mt-0.5 shrink-0"
                >
                  <Star
                    className={cn(
                      'h-3.5 w-3.5',
                      c.isPrimary
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-slate-300 hover:text-amber-400',
                    )}
                    aria-hidden
                  />
                </button>
              ) : c.isPrimary ? (
                <Star
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
                  aria-hidden
                />
              ) : (
                <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-slate-800">
                    {dealContactName(c)}
                  </span>
                </div>
                {c.title ? (
                  <div className="truncate text-[11px] text-slate-500">
                    {c.title}
                  </div>
                ) : null}
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  {c.email ? (
                    <a
                      href={`mailto:${c.email}`}
                      className="inline-flex items-center gap-0.5 hover:text-indigo-600"
                    >
                      <Mail className="h-3 w-3" aria-hidden />
                      {c.email}
                    </a>
                  ) : null}
                  {c.phone ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Phone className="h-3 w-3" aria-hidden />
                      {c.phone}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1">
                  {canEdit ? (
                    <select
                      value={c.role}
                      disabled={pending}
                      onChange={(e) =>
                        run(() =>
                          updateDealContactRoleAction({
                            id: c.id,
                            dealId,
                            role: e.target.value as DealContactRole,
                          }),
                        )
                      }
                      className={cn(
                        'rounded px-1 py-0 text-[10px] font-medium uppercase tracking-wide focus:outline-none',
                        ROLE_BADGE[c.role],
                      )}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {DEAL_CONTACT_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className={cn(
                        'rounded px-1 py-0 text-[10px] font-medium uppercase tracking-wide',
                        ROLE_BADGE[c.role],
                      )}
                    >
                      {DEAL_CONTACT_ROLE_LABELS[c.role]}
                    </span>
                  )}
                </div>
              </div>

              {canEdit ? (
                <button
                  type="button"
                  aria-label="Remove stakeholder"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => removeDealContactAction({ id: c.id, dealId }),
                      'Stakeholder removed',
                    )
                  }
                  className="mt-0.5 shrink-0 text-slate-300 hover:text-rose-500"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {mode !== 'closed' ? (
        <div className="mt-2 border-t border-slate-200 pt-2">
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setMode('existing')}
              className={cn(
                'font-medium',
                mode === 'existing' ? 'text-indigo-600' : 'text-slate-400',
              )}
            >
              Search existing
            </button>
            <span className="text-slate-300">·</span>
            <button
              type="button"
              onClick={() => setMode('new')}
              className={cn(
                'font-medium',
                mode === 'new' ? 'text-indigo-600' : 'text-slate-400',
              )}
            >
              Create new
            </button>
            <button
              type="button"
              onClick={() => setMode('closed')}
              aria-label="Close"
              className="ml-auto text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>

          {mode === 'existing' ? (
            <AddExisting
              available={available}
              pending={pending}
              onAdd={(contactId, role) =>
                run(
                  () => addDealContactAction({ dealId, contactId, role }),
                  'Stakeholder added',
                )
              }
            />
          ) : (
            <CreateNew
              pending={pending}
              onCreate={(fields) =>
                run(
                  () => createAndLinkContactAction({ dealId, ...fields }),
                  'Contact created and linked',
                )
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function AddExisting({
  available,
  pending,
  onAdd,
}: {
  available: ContactOption[];
  pending: boolean;
  onAdd: (contactId: string, role: DealContactRole) => void;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<DealContactRole>('other');
  const filtered = query.trim()
    ? available.filter((c) =>
        c.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : available;

  if (available.length === 0) {
    return (
      <p className="text-[11px] text-slate-500">
        No other contacts to add. Try creating a new one.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search contacts…"
        className="w-full rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-400 focus:outline-none"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as DealContactRole)}
        className="w-full rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-400 focus:outline-none"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {DEAL_CONTACT_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <ul className="max-h-40 overflow-y-auto rounded border border-slate-100">
        {filtered.slice(0, 30).map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={pending}
              onClick={() => onAdd(c.id, role)}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-indigo-50 disabled:opacity-50"
            >
              <UserPlus className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
              <span className="truncate">{c.label}</span>
            </button>
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="px-2 py-1 text-[11px] text-slate-400">No matches.</li>
        ) : null}
      </ul>
    </div>
  );
}

function CreateNew({
  pending,
  onCreate,
}: {
  pending: boolean;
  onCreate: (fields: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    title?: string;
    role: DealContactRole;
  }) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<DealContactRole>('other');

  const inputCls =
    'w-full rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-400 focus:outline-none';

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <input
          className={inputCls}
          placeholder="First name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="Last name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
      </div>
      <input
        className={inputCls}
        placeholder="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <input
          className={inputCls}
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as DealContactRole)}
        className={inputCls}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {DEAL_CONTACT_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          onCreate({
            firstName: firstName.trim() || undefined,
            lastName: lastName.trim() || undefined,
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            title: title.trim() || undefined,
            role,
          })
        }
        className="inline-flex w-full items-center justify-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Create & link
      </button>
    </div>
  );
}
