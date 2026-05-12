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
import { requireMembership } from '@/lib/membership';
import { listNotesForEntity } from '@/lib/notes/queries';
import { canManageDeals } from '@/lib/rbac';

import { ActivityList } from '../../activity/_components/activity-list';
import { NotesTimeline } from '../../_components/notes-timeline';
import { StageBadge } from '../_components/stage-badge';
import { DealOwnerPicker } from './_components/deal-owner-picker';
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

/**
 * Author display lookup for notes. Reuses the same seeded-actor name
 * resolution we use in the activity feed — Clerk users come through
 * with their real names, seeded actors get realistic personas, and
 * unknown ids fall back to "Teammate" (never the raw id).
 */
async function resolveAuthorLookup(
  authorIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (authorIds.length === 0) return out;

  // Skip seeded actors — their friendly name lives on each
  // activity_log.metadata.actor entry, but we can derive it from the
  // id pattern alone since the seed uses `seed-actor-<first>-<last>`.
  const realIds = authorIds.filter((id) => !id.startsWith('seed-actor-'));

  for (const id of authorIds) {
    if (id.startsWith('seed-actor-')) {
      const rest = id.slice('seed-actor-'.length);
      const parts = rest.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1));
      out[id] = parts.join(' ');
    }
  }

  if (realIds.length > 0) {
    const { clerkClient } = await import('@clerk/nextjs/server');
    const client = await clerkClient();
    try {
      const list = await client.users.getUserList({
        userId: realIds,
        limit: 500,
      });
      for (const u of list.data) {
        const parts = [u.firstName, u.lastName].filter(Boolean) as string[];
        out[u.id] = parts.length > 0
          ? parts.join(' ')
          : u.primaryEmailAddress?.emailAddress ?? 'Teammate';
      }
    } catch {
      // Tolerate transient Clerk failure; fall through to "Teammate".
    }
  }
  return out;
}

export default async function DealDetailPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;

    const deal = await getDealById(tenant.id, id);
    if (!deal) notFound();

    const [membership, activity, cachedSummary, notes] = await Promise.all([
      requireMembership(),
      listActivityForEntity(tenant.id, 'deal', deal.id, { limit: 50 }),
      getCachedSummary(tenant.id, 'deal', deal.id),
      listNotesForEntity(tenant.id, 'deal', deal.id, { limit: 100 }),
    ]);

    const canEdit = canManageDeals(membership.role);

    // Resolve author display names for the notes timeline. Pool the
    // ids and run a single batched lookup.
    const noteAuthorIds = Array.from(
      new Set(notes.map((n) => n.authorUserId)),
    );
    const authorLookup = await resolveAuthorLookup(
      [...noteAuthorIds, ...(deal.ownerId ? [deal.ownerId] : [])],
    );

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <Link
          href="/dashboard/deals"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          All deals
        </Link>

        <header className="mt-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {deal.name}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {DEAL_STAGE_LABELS[deal.stage]} ·{' '}
              <span className="font-mono">
                {formatCurrency(deal.amountMinor, deal.currency)}
              </span>
            </p>
          </div>
          <StageBadge stage={deal.stage} />
        </header>

        <div className="mt-6 grid gap-4 lg:grid-cols-[320px_1fr]">
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
            <DealOwnerPicker
              dealId={deal.id}
              currentOwnerId={deal.ownerId}
              currentOwnerName={
                deal.ownerId ? authorLookup[deal.ownerId] ?? null : null
              }
              currentUserId={userId}
              canEdit={canEdit}
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

          <section className="space-y-4">
            <SummaryCard
              dealId={deal.id}
              initialSummary={cachedSummary?.summary ?? null}
              initialGeneratedAt={cachedSummary?.generatedAt.toISOString() ?? null}
              aiMode={getAIMode()}
            />

            <NotesTimeline
              entityType="deal"
              entityId={deal.id}
              currentUserId={userId}
              initialNotes={notes}
              authorLookup={authorLookup}
              canWrite={canEdit}
            />

            <div>
              <h2 className="mb-3 text-[13px] font-semibold text-slate-900">
                Timeline
              </h2>
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
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
