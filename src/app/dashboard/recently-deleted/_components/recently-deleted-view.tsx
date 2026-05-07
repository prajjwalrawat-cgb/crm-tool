'use client';

import { Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';

import type { Company, Contact, MembershipRole } from '@/db/schema';
import { restoreCompanyAction } from '@/app/dashboard/companies/actions';
import { restoreContactAction } from '@/app/dashboard/contacts/actions';
import { restoreDealAction } from '@/app/dashboard/deals/actions';
import { formatCurrency } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import {
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

type DeletedSet =
  | { type: 'company'; rows: Company[] }
  | { type: 'contact'; rows: Contact[] }
  | { type: 'deal'; rows: DealRow[] };

function contactName(c: Contact): string {
  const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return c.email ?? c.id;
}

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
  const [error, setError] = useState<string | null>(null);

  const total = companies.length + contacts.length + deals.length;

  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-6 py-16 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <Trash2 className="mx-auto h-10 w-10 text-zinc-400" aria-hidden />
        <h2 className="mt-4 text-base font-semibold">Trash is empty</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Nothing has been soft-deleted in this tenant.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {companies.length > 0 ? (
        <CompaniesSection
          rows={companies}
          canRestore={canRestoreCompanies(currentRole)}
          onError={setError}
        />
      ) : null}

      {contacts.length > 0 ? (
        <ContactsSection
          rows={contacts}
          canRestore={canRestoreContacts(currentRole)}
          onError={setError}
        />
      ) : null}

      {deals.length > 0 ? (
        <DealsSection
          rows={deals}
          canRestore={canRestoreDeals(currentRole)}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

/* -------- companies -------- */

function CompaniesSection({
  rows,
  canRestore,
  onError,
}: {
  rows: Company[];
  canRestore: boolean;
  onError: (msg: string | null) => void;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<Company[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted companies" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Domain</Th>
            <Th hidden="md">Industry</Th>
            <Th align="right">Deleted</Th>
            {canRestore ? <Th align="right">Action</Th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {optimisticRows.map((c) => (
            <RestorableRow
              key={c.id}
              entity="company"
              id={c.id}
              canRestore={canRestore}
              onError={onError}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{c.name}</span>,
                <span key="domain" className="text-zinc-600 dark:text-zinc-400">{c.domain ?? '—'}</span>,
                <span key="industry" className="text-zinc-600 dark:text-zinc-400">{c.industry ?? '—'}</span>,
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
  onError,
}: {
  rows: Contact[];
  canRestore: boolean;
  onError: (msg: string | null) => void;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<Contact[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted contacts" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Email</Th>
            <Th hidden="md">Title</Th>
            <Th align="right">Deleted</Th>
            {canRestore ? <Th align="right">Action</Th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {optimisticRows.map((c) => (
            <RestorableRow
              key={c.id}
              entity="contact"
              id={c.id}
              canRestore={canRestore}
              onError={onError}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{contactName(c)}</span>,
                <span key="email" className="text-zinc-600 dark:text-zinc-400">{c.email ?? '—'}</span>,
                <span key="title" className="text-zinc-600 dark:text-zinc-400">{c.title ?? '—'}</span>,
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
  onError,
}: {
  rows: DealRow[];
  canRestore: boolean;
  onError: (msg: string | null) => void;
}) {
  const [optimisticRows, removeOptimistic] = useOptimistic<DealRow[], string>(
    rows,
    (state, idToRemove) => state.filter((r) => r.id !== idToRemove),
  );

  return (
    <Section title="Deleted deals" count={optimisticRows.length}>
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
          <tr>
            <Th>Name</Th>
            <Th hidden="sm">Stage</Th>
            <Th align="right">Amount</Th>
            <Th align="right">Deleted</Th>
            {canRestore ? <Th align="right">Action</Th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {optimisticRows.map((d) => (
            <RestorableRow
              key={d.id}
              entity="deal"
              id={d.id}
              canRestore={canRestore}
              onError={onError}
              onOptimistic={removeOptimistic}
              cells={[
                <span key="name" className="font-medium">{d.name}</span>,
                <span key="stage" className="text-zinc-600 dark:text-zinc-400">{DEAL_STAGE_LABELS[d.stage]}</span>,
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
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-zinc-500">{count}</span>
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
        'px-4 py-2.5 font-medium',
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

type Entity = 'company' | 'contact' | 'deal';

function RestorableRow({
  entity,
  id,
  canRestore,
  onError,
  onOptimistic,
  cells,
  hiddenAt,
  alignRight,
}: {
  entity: Entity;
  id: string;
  canRestore: boolean;
  onError: (msg: string | null) => void;
  onOptimistic: (id: string) => void;
  cells: React.ReactNode[];
  hiddenAt: Array<'' | 'sm' | 'md' | 'lg'>;
  alignRight: boolean[];
}) {
  const [pending, startTransition] = useTransition();

  function handleRestore() {
    onError(null);
    startTransition(async () => {
      onOptimistic(id);
      const action =
        entity === 'company'
          ? restoreCompanyAction
          : entity === 'contact'
            ? restoreContactAction
            : restoreDealAction;
      const result = await action(id);
      if (!result.ok) onError(result.message);
    });
  }

  return (
    <tr className={cn(pending && 'opacity-60')}>
      {cells.map((cell, i) => (
        <td
          key={i}
          className={cn(
            'whitespace-nowrap px-4 py-3',
            alignRight[i] && 'text-right',
            i === cells.length - 1 && 'text-xs text-zinc-500',
            hiddenAt[i] === 'sm' && 'hidden sm:table-cell',
            hiddenAt[i] === 'md' && 'hidden md:table-cell',
            hiddenAt[i] === 'lg' && 'hidden lg:table-cell',
          )}
        >
          {cell}
        </td>
      ))}
      {canRestore ? (
        <td className="whitespace-nowrap px-4 py-3 text-right">
          <button
            type="button"
            onClick={handleRestore}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="h-3 w-3" aria-hidden />
            )}
            Restore
          </button>
        </td>
      ) : null}
    </tr>
  );
}
