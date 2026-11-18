import { desc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';

import { callCampaignItems, callCampaigns, leadSources } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { listTeammates } from '@/lib/teammates/queries';

import { CreateCampaignForm } from './_components/create-campaign-form';

export const metadata = { title: 'Dialer campaigns' };

export default async function CampaignsPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const isManager = ['owner', 'admin', 'manager'].includes(membership.role);
    const rows = await tenantTransaction(async (tx) => {
      const list = await tx
        .select({
          id: callCampaigns.id,
          name: callCampaigns.name,
          mode: callCampaigns.mode,
          status: callCampaigns.status,
          agentIds: callCampaigns.agentIds,
          createdAt: callCampaigns.createdAt,
          total: sql<number>`(select count(*)::int from ${callCampaignItems} i where i.campaign_id = ${callCampaigns.id})`,
          remaining: sql<number>`(select count(*)::int from ${callCampaignItems} i where i.campaign_id = ${callCampaigns.id} and i.state in ('pending','locked'))`,
        })
        .from(callCampaigns)
        .where(eq(callCampaigns.tenantId, tenant.id))
        .orderBy(desc(callCampaigns.createdAt))
        .limit(100);
      const sources = await tx.select({ id: leadSources.id, name: leadSources.name }).from(leadSources).where(eq(leadSources.tenantId, tenant.id));
      return { list, sources };
    });
    const visible = isManager ? rows.list : rows.list.filter((c) => c.agentIds.includes(userId));
    const teammates = isManager ? (await listTeammates(tenant.id, tenant.name)).filter((t) => t.source === 'user') : [];

    return (
      <main className="mx-auto w-full max-w-[80rem] space-y-5 px-4 py-6 sm:px-5 lg:px-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Dialer campaigns</h1>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            Work a list of leads one call at a time. Preview mode shows the lead first and you press Call; progressive mode dials the next lead as soon as you save a disposition.
          </p>
        </header>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0F0F0F] dark:text-[#A1A1AA]">
              <tr>
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Remaining</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 dark:border-[#181818]">
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-[#FAFAFA]">
                    <Link href={`/dashboard/telephony/campaigns/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 capitalize text-slate-600 dark:text-[#A1A1AA]">{c.mode}</td>
                  <td className="px-3 py-2 capitalize text-slate-600 dark:text-[#A1A1AA]">{c.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number(c.remaining)} / {Number(c.total)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {c.status === 'running' && c.agentIds.includes(userId) ? (
                      <Link href={`/dashboard/telephony/campaigns/${c.id}/dialer`} className="rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-indigo-500">
                        Open dialer
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                    No campaigns yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        {isManager ? <CreateCampaignForm agents={teammates.map((t) => ({ id: t.id, name: t.displayName }))} sources={rows.sources} /> : null}
      </main>
    );
  });
}
