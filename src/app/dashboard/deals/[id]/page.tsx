import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { listActivityForEntity } from '@/lib/activity/queries';
import { getAIMode } from '@/lib/ai/config';
import { getCachedSummary } from '@/lib/ai/summary-queries';
import { withTenantSession } from '@/lib/auth-guard';
import { formatCurrency } from '@/lib/deals/currency';
import { getDealById } from '@/lib/deals/queries';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';

import { ActivityList } from '../../activity/_components/activity-list';
import { StageBadge } from '../_components/stage-badge';
import { SummaryCard } from './_components/summary-card';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const metadata = {
  title: 'Deal',
};

type Params = Promise<{ id: string }>;

export default async function DealDetailPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant }) => {
    const { id } = await params;

    const deal = await getDealById(tenant.id, id);
    if (!deal) notFound();

    const [activity, cachedSummary] = await Promise.all([
      listActivityForEntity(tenant.id, 'deal', deal.id, { limit: 50 }),
      getCachedSummary(tenant.id, 'deal', deal.id),
    ]);

    return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/dashboard/deals"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden />
        All deals
      </Link>

      <header className="mt-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{deal.name}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {DEAL_STAGE_LABELS[deal.stage]} ·{' '}
            <span className="font-mono">
              {formatCurrency(deal.amountMinor, deal.currency)}
            </span>
          </p>
        </div>
        <StageBadge stage={deal.stage} />
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="flex flex-col gap-3">
          <DetailCard label="Stage" value={DEAL_STAGE_LABELS[deal.stage]} />
          <DetailCard
            label="Amount"
            value={formatCurrency(deal.amountMinor, deal.currency)}
            mono
          />
          <DetailCard
            label="Expected close"
            value={
              deal.expectedCloseDate
                ? dateFormatter.format(new Date(deal.expectedCloseDate))
                : '—'
            }
          />
          <DetailCard label="Company" value={deal.companyName ?? '—'} />
          <DetailCard
            label="Contact"
            value={deal.contactName ?? deal.contactEmail ?? '—'}
          />
          <DetailCard
            label="Created"
            value={dateFormatter.format(new Date(deal.createdAt))}
          />
          {deal.closedAt ? (
            <DetailCard
              label="Closed"
              value={dateFormatter.format(new Date(deal.closedAt))}
            />
          ) : null}
        </aside>

        <section className="space-y-6">
          <SummaryCard
            dealId={deal.id}
            initialSummary={cachedSummary?.summary ?? null}
            initialGeneratedAt={cachedSummary?.generatedAt.toISOString() ?? null}
            aiMode={getAIMode()}
          />
          <div>
            <h2 className="mb-3 text-base font-semibold">Timeline</h2>
            <ActivityList
              rows={activity}
              emptyMessage="No activity recorded for this deal yet."
            />
          </div>
        </section>
      </div>
    </main>
    );
  });
}

function DetailCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-1 text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
