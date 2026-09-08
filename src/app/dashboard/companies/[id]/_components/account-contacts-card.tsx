import { Mail, Phone, UserPlus, Users } from 'lucide-react';

import type { AccountContactSummary } from '@/lib/companies/account-360';

import { HoverPrefetchLink } from '../../../_components/hover-prefetch-link';

/**
 * Contacts rollup for the Account 360 right rail.
 *
 * Shows the account's most recently touched contacts and links out to
 * the full, filtered list. `total` is the account's real contact count,
 * not `rows.length` — the card deliberately shows fewer rows than it
 * counts, and the header is what tells you so.
 *
 * "View All" points at the existing Contacts list with the existing
 * `companyId=` filter param (see `lib/contacts/filters.ts`), so the
 * destination arrives filtered rather than merely navigated to.
 */
export function AccountContactsCard({
  companyId,
  rows,
  total,
}: {
  companyId: string;
  rows: AccountContactSummary[];
  total: number;
}) {
  const viewAllHref = `/dashboard/contacts?companyId=${companyId}`;
  const hidden = Math.max(0, total - rows.length);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-900">
          <Users className="h-3.5 w-3.5 text-slate-400" aria-hidden />
          Contacts
          <span className="tabular-nums text-slate-400">({total})</span>
        </h2>
        {total > 0 ? (
          <HoverPrefetchLink
            href={viewAllHref}
            className="rounded px-1 py-0.5 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50 hover:text-indigo-700"
          >
            View all
          </HoverPrefetchLink>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center">
          <UserPlus className="h-6 w-6 text-slate-400" aria-hidden />
          <p className="mt-2 text-[12px] font-medium text-slate-700">
            No contacts yet
          </p>
          <p className="mt-0.5 max-w-[15rem] text-[11.5px] text-slate-500">
            Nobody at this account is on record. Add a contact to start
            tracking who you know here.
          </p>
          <HoverPrefetchLink
            href="/dashboard/contacts"
            className="mt-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            Add a contact
          </HoverPrefetchLink>
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-slate-100">
            {rows.map((c) => {
              const name =
                [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                c.email ||
                'Unnamed contact';
              return (
                <li key={c.id} className="py-1.5 first:pt-0 last:pb-0">
                  <HoverPrefetchLink
                    href={`/dashboard/contacts/${c.id}`}
                    className="group block rounded-md px-1 py-0.5 transition hover:bg-slate-50"
                  >
                    <div className="truncate text-[12.5px] font-medium text-slate-900 group-hover:text-indigo-700">
                      {name}
                    </div>
                    {c.title ? (
                      <div className="truncate text-[11px] text-slate-500">
                        {c.title}
                      </div>
                    ) : null}
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {c.email ? (
                        <span className="flex items-center gap-1 truncate text-[11px] text-slate-500">
                          <Mail
                            className="h-2.5 w-2.5 shrink-0 text-slate-400"
                            aria-hidden
                          />
                          <span className="truncate">{c.email}</span>
                        </span>
                      ) : null}
                      {c.phone ? (
                        <span className="flex items-center gap-1 truncate text-[11px] tabular-nums text-slate-500">
                          <Phone
                            className="h-2.5 w-2.5 shrink-0 text-slate-400"
                            aria-hidden
                          />
                          <span className="truncate">{c.phone}</span>
                        </span>
                      ) : null}
                    </div>
                  </HoverPrefetchLink>
                </li>
              );
            })}
          </ul>
          {hidden > 0 ? (
            <HoverPrefetchLink
              href={viewAllHref}
              className="mt-2 block rounded-md border border-slate-200 px-2 py-1 text-center text-[11px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            >
              +{hidden} more {hidden === 1 ? 'contact' : 'contacts'}
            </HoverPrefetchLink>
          ) : null}
        </>
      )}
    </section>
  );
}
