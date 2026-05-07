'use client';

import { Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';

import type { CompanyOption } from '@/lib/companies/queries';
import type { ContactOption } from '@/lib/contacts/queries';
import { formatCurrency, toMinorUnits } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { type DealStage, DEAL_STAGES } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

import { createDealAction } from '../actions';
import { CreateDealForm } from './create-deal-form';
import { EmptyState } from './empty-state';
import { StageBadge } from './stage-badge';

type DealItem = DealRow & { __pending?: boolean };

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
}: {
  initialItems: DealRow[];
  initialSearch: string;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [submitPending, startSubmitTransition] = useTransition();

  const [optimisticItems, addOptimistic] = useOptimistic<DealItem[], DealItem>(
    initialItems,
    (state, draft) => [draft, ...state],
  );

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [resetKey, setResetKey] = useState(0);

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
        const qs = params.toString();
        router.replace(`/dashboard/deals${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router]);

  function handleSubmit(formData: FormData) {
    setSubmitError(null);
    setFieldErrors({});

    const name = String(formData.get('name') ?? '').trim();
    const stageRaw = String(formData.get('stage') ?? 'lead');
    const stage: DealStage = isDealStage(stageRaw) ? stageRaw : 'lead';
    const amountRaw = String(formData.get('amount') ?? '0');
    const amountNum = Number(amountRaw);
    const currency = String(formData.get('currency') ?? 'USD');
    const expectedCloseDate =
      String(formData.get('expectedCloseDate') ?? '').trim() || null;
    const companyId =
      String(formData.get('companyId') ?? '').trim() || null;
    const contactId =
      String(formData.get('contactId') ?? '').trim() || null;

    const companyName = companyId
      ? companyOptions.find((c) => c.id === companyId)?.name ?? null
      : null;
    const contact = contactId
      ? contactOptions.find((c) => c.id === contactId) ?? null
      : null;

    const amountMinor = Number.isFinite(amountNum)
      ? toMinorUnits(amountNum, currency)
      : 0;

    const draft: DealItem = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      companyId,
      contactId,
      name: name || '(unnamed deal)',
      stage,
      amountMinor,
      currency,
      expectedCloseDate,
      closedAt: stage === 'won' || stage === 'lost' ? new Date() : null,
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      companyName,
      contactName: contact?.label ?? null,
      contactEmail: null,
      __pending: true,
    };

    startSubmitTransition(async () => {
      addOptimistic(draft);
      const result = await createDealAction(formData);
      if (!result.ok) {
        setSubmitError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      } else {
        setResetKey((k) => k + 1);
      }
    });
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

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <DealsTable items={optimisticItems} />
        )}
      </section>

      <aside>
        <CreateDealForm
          onSubmit={handleSubmit}
          pending={submitPending}
          error={submitError}
          fieldErrors={fieldErrors}
          resetKey={resetKey}
          companyOptions={companyOptions}
          contactOptions={contactOptions}
        />
      </aside>
    </div>
  );
}

function DealsTable({ items }: { items: DealItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Stage
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Amount
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium md:table-cell"
              >
                Company
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium lg:table-cell"
              >
                Contact
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-right font-medium sm:table-cell"
              >
                Close date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((d) => (
              <tr
                key={d.id}
                className={cn(
                  'transition-opacity',
                  d.__pending && 'opacity-60',
                )}
              >
                <td className="px-4 py-3">
                  <div className="font-medium">{d.name}</div>
                </td>
                <td className="px-4 py-3">
                  <StageBadge stage={d.stage} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-mono">
                  {formatCurrency(d.amountMinor, d.currency)}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 md:table-cell dark:text-zinc-400">
                  {d.companyName ?? '—'}
                </td>
                <td className="hidden px-4 py-3 text-zinc-600 lg:table-cell dark:text-zinc-400">
                  {d.contactName ?? d.contactEmail ?? '—'}
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-right text-xs text-zinc-500 sm:table-cell">
                  {d.expectedCloseDate
                    ? dateFormatter.format(new Date(d.expectedCloseDate))
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
