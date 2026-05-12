'use client';

import { Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Company, Contact, MembershipRole } from '@/db/schema';
import {
  hardDeleteCompanyAction,
  restoreCompanyAction,
} from '@/app/dashboard/companies/actions';
import {
  hardDeleteContactAction,
  restoreContactAction,
} from '@/app/dashboard/contacts/actions';
import {
  hardDeleteDealAction,
  restoreDealAction,
} from '@/app/dashboard/deals/actions';
import { formatCurrency } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import {
  canHardDeleteCompanies,
  canHardDeleteContacts,
  canHardDeleteDeals,
  canRestoreCompanies,
  canRestoreContacts,
  canRestoreDeals,
} from '@/lib/rbac';
import { cn } from '@/lib/utils';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function contactName(c: Contact): string {
  const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return c.email ?? c.id;
}

type Entity = 'company' | 'contact' | 'deal';

const ENTITY_LABEL: Record<Entity, string> = {
  company: 'Company',
  contact: 'Contact',
  deal: 'Deal',
};

const restoreActions = {
  company: restoreCompanyAction,
  contact: restoreContactAction,
  deal: restoreDealAction,
} as const;

const hardDeleteActions = {
  company: hardDeleteCompanyAction,
  contact: hardDeleteContactAction,
  deal: hardDeleteDealAction,
} as const;

export function RecentlyDeletedView({
  companies,
  contacts,
  deals,
  currentRole,
}: {
  companies: Company[];
  contacts: Contact[];
  deals: DealRow[];
  currentRole: MembershipRole;
}) {
  const total = companies.length + contacts.length + deals.length;

  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center">
        <Trash2 className="mx-auto h-10 w-10 text-slate-400" aria-hidden />
        <h2 className="mt-4 text-base font-semibold">Trash is empty</h2>
        <p className="mt-0.5 text-[12px] text-slate-500">
          Nothing has been soft-deleted in this tenant.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {companies.length > 0 ? (
        <CompaniesSection
          rows={companies}
          canRestore={canRestoreCompanies(currentRole)}
          canHardDelete={canHardDeleteCompanies(currentRole)}
        />
      ) : null}

      {contacts.length > 0 ? (
        <ContactsSection
          rows={contacts}
          canRestore={canRestoreContacts(currentRole)}
          canHardDelete={canHardDeleteContacts(currentRole)}
        />
      ) : null}

      {deals.length > 0 ? (
        <DealsSection
          rows={deals}
          canRestore={canRestoreDeals(currentRole)}
          canHardDelete={canHardDeleteDeals(currentRole)}
        />
      ) : null}
    </div>
  );
}

/* -------- companies -------- */

function CompaniesSection({
  rows,
  canRestore,
  canHardDelete,
}: {
  rows: Company[];
  canRestore: boolean;
  canHardDelete: boolean;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<Company[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted companies" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
        <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Domain</Th>
            <Th hidden="md">Industry</Th>
            <Th align="right">Deleted</Th>
            {canRestore || canHardDelete ? (
              <Th align="right">Actions</Th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {optimisticRows.map((c) => (
            <RestorableRow
              key={c.id}
              entity="company"
              id={c.id}
              displayName={c.name}
              canRestore={canRestore}
              canHardDelete={canHardDelete}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{c.name}</span>,
                <span key="domain" className="text-slate-600">{c.domain ?? '—'}</span>,
                <span key="industry" className="text-slate-600">{c.industry ?? '—'}</span>,
                c.deletedAt ? dateFormatter.format(new Date(c.deletedAt)) : '—',
              ]}
              hiddenAt={['', 'sm', 'md', '']}
              alignRight={[false, false, false, true]}
            />
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* -------- contacts -------- */

function ContactsSection({
  rows,
  canRestore,
  canHardDelete,
}: {
  rows: Contact[];
  canRestore: boolean;
  canHardDelete: boolean;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<Contact[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted contacts" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
        <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Email</Th>
            <Th hidden="md">Title</Th>
            <Th align="right">Deleted</Th>
            {canRestore || canHardDelete ? (
              <Th align="right">Actions</Th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {optimisticRows.map((c) => (
            <RestorableRow
              key={c.id}
              entity="contact"
              id={c.id}
              displayName={contactName(c)}
              canRestore={canRestore}
              canHardDelete={canHardDelete}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{contactName(c)}</span>,
                <span key="email" className="text-slate-600">{c.email ?? '—'}</span>,
                <span key="title" className="text-slate-600">{c.title ?? '—'}</span>,
                c.deletedAt ? dateFormatter.format(new Date(c.deletedAt)) : '—',
              ]}
              hiddenAt={['', 'sm', 'md', '']}
              alignRight={[false, false, false, true]}
            />
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* -------- deals -------- */

function DealsSection({
  rows,
  canRestore,
  canHardDelete,
}: {
  rows: DealRow[];
  canRestore: boolean;
  canHardDelete: boolean;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<DealRow[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted deals" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-slate-100 text-[13px]">
        <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Stage</Th>
            <Th align="right">Amount</Th>
            <Th align="right">Deleted</Th>
            {canRestore || canHardDelete ? (
              <Th align="right">Actions</Th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {optimisticRows.map((d) => (
            <RestorableRow
              key={d.id}
              entity="deal"
              id={d.id}
              displayName={d.name}
              canRestore={canRestore}
              canHardDelete={canHardDelete}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{d.name}</span>,
                <span key="stage" className="text-slate-600">{DEAL_STAGE_LABELS[d.stage]}</span>,
                <span key="amount" className="font-mono">{formatCurrency(d.amountMinor, d.currency)}</span>,
                d.deletedAt ? dateFormatter.format(new Date(d.deletedAt)) : '—',
              ]}
              hiddenAt={['', 'sm', '', '']}
              alignRight={[false, false, true, true]}
            />
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/* -------- shared bits -------- */

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-slate-500">{count}</span>
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function Th({
  children,
  align = 'left',
  hidden,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  hidden?: 'sm' | 'md' | 'lg';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
        hidden === 'sm' && 'hidden sm:table-cell',
        hidden === 'md' && 'hidden md:table-cell',
        hidden === 'lg' && 'hidden lg:table-cell',
      )}
    >
      {children}
    </th>
  );
}

function RestorableRow({
  entity,
  id,
  displayName,
  canRestore,
  canHardDelete,
  onOptimistic,
  cells,
  hiddenAt,
  alignRight,
}: {
  entity: Entity;
  id: string;
  displayName: string;
  canRestore: boolean;
  canHardDelete: boolean;
  onOptimistic: (id: string) => void;
  cells: React.ReactNode[];
  hiddenAt: Array<'' | 'sm' | 'md' | 'lg'>;
  alignRight: boolean[];
}) {
  const [pending, startTransition] = useTransition();
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const label = ENTITY_LABEL[entity].toLowerCase();

  function handleRestore() {
    startTransition(async () => {
      onOptimistic(id);
      const result = await restoreActions[entity](id);
      if (result.ok) {
        toast.success(`${ENTITY_LABEL[entity]} restored`, {
          description: displayName,
        });
      } else {
        toast.error(`Restore failed`, { description: result.message });
      }
    });
  }

  function handleHardDelete() {
    setConfirmingPurge(false);
    startTransition(async () => {
      onOptimistic(id);
      const result = await hardDeleteActions[entity](id);
      if (result.ok) {
        toast.success(`${ENTITY_LABEL[entity]} permanently deleted`, {
          description: displayName,
        });
      } else {
        toast.error('Permanent delete failed', { description: result.message });
      }
    });
  }

  return (
    <tr className={cn(pending && 'opacity-60')}>
      {cells.map((cell, i) => (
        <td
          key={i}
          className={cn(
            'whitespace-nowrap px-3 py-2',
            alignRight[i] && 'text-right',
            i === cells.length - 1 && 'text-xs text-slate-500',
            hiddenAt[i] === 'sm' && 'hidden sm:table-cell',
            hiddenAt[i] === 'md' && 'hidden md:table-cell',
            hiddenAt[i] === 'lg' && 'hidden lg:table-cell',
          )}
        >
          {cell}
        </td>
      ))}
      {canRestore || canHardDelete ? (
        <td className="whitespace-nowrap px-3 py-2 text-right">
          {confirmingPurge && canHardDelete ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[11px] text-slate-500">
                Permanent — cannot be undone.
              </span>
              <button
                type="button"
                onClick={handleHardDelete}
                disabled={pending}
                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-3 w-3" aria-hidden />
                )}
                Delete forever
              </button>
              <button
                type="button"
                onClick={() => setConfirmingPurge(false)}
                disabled={pending}
                aria-label="Cancel permanent delete"
                className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {canRestore ? (
                <button
                  type="button"
                  onClick={handleRestore}
                  disabled={pending}
                  title={`Restore ${label}`}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-60"
                >
                  {pending ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="h-3 w-3" aria-hidden />
                  )}
                  Restore
                </button>
              ) : null}
              {canHardDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingPurge(true)}
                  disabled={pending}
                  title={`Permanently delete ${label}`}
                  aria-label={`Permanently delete ${label}`}
                  className="rounded-md border border-slate-200 p-1 text-slate-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              ) : null}
            </span>
          )}
        </td>
      ) : null}
    </tr>
  );
}
