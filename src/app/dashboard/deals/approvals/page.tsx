import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { formatCurrency } from '@/lib/deals/currency';
import {
  listDealsAwaitingApproval,
  listRecentlyApprovedDeals,
  listRecentlyRejectedDeals,
} from '@/lib/deals/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { resolveAuthorLookup } from '../../_components/author-lookup';

import { ApprovalQueue } from './_components/approval-queue';

const approvedFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const metadata = { title: 'Approvals' };

export default async function DealApprovalsPage() {
  // owner + admin + manager (the approver roles).
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const [deals, approved, rejected] = await Promise.all([
      listDealsAwaitingApproval(tenant.id),
      listRecentlyApprovedDeals(tenant.id),
      listRecentlyRejectedDeals(tenant.id),
    ]);

    // Resolve owner + reviewer display names in one batch.
    const people = new Set<string>();
    for (const d of deals) if (d.ownerId) people.add(d.ownerId);
    for (const d of [...approved, ...rejected]) {
      if (d.ownerId) people.add(d.ownerId);
      if (d.approvedBy) people.add(d.approvedBy);
    }
    const lookup = await resolveAuthorLookup(Array.from(people));

    const rows = deals.map((d) => ({
      id: d.id,
      name: d.name,
      amountMinor: d.amountMinor,
      marginBps: d.marginBps,
      currency: d.currency,
      companyName: d.companyName,
      contactName: d.contactName,
      contactEmail: d.contactEmail,
      ownerName: d.ownerId ? lookup[d.ownerId] ?? null : null,
    }));

    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/deals"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All deals
        </Link>
        <h1 className="mt-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          Deal approvals
        </h1>
        <p className="mt-0.5 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          Won deals awaiting your sign-off. Approving lets a deal count toward
          sales targets; rejecting reopens it to Negotiation.
        </p>
        <div className="mt-5">
          <ApprovalQueue rows={rows} />
        </div>

        <section className="mt-8">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Recently approved
          </h2>
          {approved.length === 0 ? (
            <p className="mt-2 text-[13px] text-slate-400">
              No approved deals yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 dark:divide-[#1F1F1F] dark:border-[#1F1F1F]">
              {approved.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 bg-white px-3 py-2.5 dark:bg-[#0A0A0A]"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/deals/${d.id}`}
                      className="text-[13px] font-medium text-slate-900 hover:underline dark:text-[#FAFAFA]"
                    >
                      {d.name}
                    </Link>
                    <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                      {[d.companyName, d.contactName ?? d.contactEmail]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[13px] text-slate-800 dark:text-[#FAFAFA]">
                      {formatCurrency(d.amountMinor, d.currency)}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                      {d.approvedBy ? `by ${lookup[d.approvedBy] ?? 'Someone'}` : ''}
                      {d.approvedAt
                        ? ` · ${approvedFormatter.format(new Date(d.approvedAt))}`
                        : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Recently rejected
          </h2>
          {rejected.length === 0 ? (
            <p className="mt-2 text-[13px] text-slate-400">
              No rejected deals.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 dark:divide-[#1F1F1F] dark:border-[#1F1F1F]">
              {rejected.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 bg-white px-3 py-2.5 dark:bg-[#0A0A0A]"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/deals/${d.id}`}
                      className="text-[13px] font-medium text-slate-900 hover:underline dark:text-[#FAFAFA]"
                    >
                      {d.name}
                    </Link>
                    <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                      {[d.companyName, d.contactName ?? d.contactEmail]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                      <span className="ml-1.5 inline-flex items-center rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                        reopened to Negotiation
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[13px] text-slate-800 dark:text-[#FAFAFA]">
                      {formatCurrency(d.amountMinor, d.currency)}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                      {d.approvedBy
                        ? `rejected by ${lookup[d.approvedBy] ?? 'Someone'}`
                        : 'rejected'}
                      {d.approvedAt
                        ? ` · ${approvedFormatter.format(new Date(d.approvedAt))}`
                        : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    );
  });
}
