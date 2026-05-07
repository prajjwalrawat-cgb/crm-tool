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
import type { ContactRow } from '@/lib/contacts/queries';
import { cn } from '@/lib/utils';

import { createContactAction } from '../actions';
import { CreateContactForm } from './create-contact-form';
import { EmptyState } from './empty-state';

type ContactItem = ContactRow & { __pending?: boolean };

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
}: {
  initialItems: ContactRow[];
  initialSearch: string;
  companyOptions: CompanyOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const [searchPending, startSearchTransition] = useTransition();
  const [submitPending, startSubmitTransition] = useTransition();

  const [optimisticItems, addOptimistic] = useOptimistic<ContactItem[], ContactItem>(
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
        router.replace(`/dashboard/contacts${qs ? `?${qs}` : ''}`);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [search, router]);

  function handleSubmit(formData: FormData) {
    setSubmitError(null);
    setFieldErrors({});

    const firstName = String(formData.get('firstName') ?? '').trim();
    const lastName = String(formData.get('lastName') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();
    const title = String(formData.get('title') ?? '').trim();
    const companyId = String(formData.get('companyId') ?? '').trim() || null;
    const companyName =
      companyId
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
      __pending: true,
    };

    startSubmitTransition(async () => {
      addOptimistic(draft);
      const result = await createContactAction(formData);
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

        {showEmpty ? (
          <EmptyState searchActive={trimmedSearch.length > 0} />
        ) : (
          <ContactsTable items={optimisticItems} />
        )}
      </section>

      <aside>
        <CreateContactForm
          onSubmit={handleSubmit}
          pending={submitPending}
          error={submitError}
          fieldErrors={fieldErrors}
          resetKey={resetKey}
          companyOptions={companyOptions}
        />
      </aside>
    </div>
  );
}

function ContactsTable({ items }: { items: ContactItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
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
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((c) => (
              <tr
                key={c.id}
                className={cn(
                  'transition-opacity',
                  c.__pending && 'opacity-60',
                )}
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
                <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-zinc-500">
                  {dateFormatter.format(new Date(c.createdAt))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
