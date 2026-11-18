import { withTenantSession } from '@/lib/auth-guard';
import { listLeadSources, listUnassignedLeads } from '@/lib/lead-capture/admin';
import { requirePersonas } from '@/lib/personas/guards';
import { listTeammates } from '@/lib/teammates/queries';

import { UnassignedQueue } from './_components/unassigned-queue';

export const metadata = { title: 'Lead queue' };

type Props = { searchParams: Promise<{ q?: string; source?: string; state?: string }> };

export default async function UnassignedLeadsPage({ searchParams }: Props) {
  await requirePersonas(['manager', 'admin']);
  const sp = await searchParams;
  const filter = {
    q: sp.q?.trim() || undefined,
    sourceId: sp.source && /^[0-9a-f-]{36}$/i.test(sp.source) ? sp.source : undefined,
    state: sp.state?.trim() || undefined,
  };
  return await withTenantSession(async ({ tenant }) => {
    const [leads, sources, teammates] = await Promise.all([
      listUnassignedLeads(tenant.id, filter),
      listLeadSources(tenant.id),
      listTeammates(tenant.id, tenant.name),
    ]);
    return (
      <main className="mx-auto w-full max-w-[80rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Lead queue</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            Captured leads no rule could place — nobody eligible, everyone off shift, or no matching rule. The
            distributor retries every 10 minutes for 6 hours; assign them here to stop the wait.
          </p>
        </header>
        <UnassignedQueue
          filter={{ q: filter.q ?? '', sourceId: filter.sourceId ?? '', state: filter.state ?? '' }}
          sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          people={teammates.filter((t) => t.role && t.role !== 'viewer').map((t) => ({ id: t.id, name: t.displayName }))}
          leads={leads.map((l) => ({
            id: l.id,
            name: l.name,
            company: l.company,
            place: [l.city, l.state].filter(Boolean).join(', '),
            productInterest: l.productInterest,
            sourceName: l.sourceName,
            queuedAt: (l.queuedAt ?? l.createdAt).toISOString(),
            contact: l.phone ?? l.email ?? null,
          }))}
        />
      </main>
    );
  });
}
