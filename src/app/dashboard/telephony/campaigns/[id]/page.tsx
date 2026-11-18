import Link from 'next/link';
import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { listTeammates } from '@/lib/teammates/queries';
import { getCampaignBoard } from '@/lib/telephony/campaigns';

import { CampaignControls } from './_components/campaign-controls';

export const metadata = { title: 'Campaign board' };

type Params = Promise<{ id: string }>;

export default async function CampaignBoardPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;
    const membership = await requireMembership();
    const isManager = ['owner', 'admin', 'manager'].includes(membership.role);
    const board = await getCampaignBoard(tenant.id, id);
    if (!board || (!isManager && !board.campaign.agentIds.includes(userId))) notFound();
    const names = new Map((await listTeammates(tenant.id, tenant.name)).map((t) => [t.id, t.displayName]));
    const c = board.campaign;
    const tiles = [
      { label: 'Calls made', value: board.callsMade.toLocaleString('en-IN') },
      { label: 'Connect rate', value: board.connectRate === null ? '—' : `${Math.round(board.connectRate * 100)}%` },
      { label: 'Remaining', value: (board.counts.pending + board.counts.locked).toLocaleString('en-IN') },
      { label: 'Done', value: board.counts.done.toLocaleString('en-IN') },
      { label: 'Skipped', value: board.counts.skipped.toLocaleString('en-IN') },
    ];
    return (
      <main className="mx-auto w-full max-w-[80rem] space-y-5 px-4 py-6 sm:px-5 lg:px-6">
        <div>
          <Link href="/dashboard/telephony/campaigns" className="text-[12px] text-slate-500 hover:text-slate-800">
            ← Campaigns
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">{c.name}</h1>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[12px] capitalize text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
              {c.status} · {c.mode}
            </span>
            <CampaignControls campaignId={c.id} status={c.status} canManage={isManager} canDial={c.agentIds.includes(userId)} />
          </div>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Calls {c.callingHours.start}–{c.callingHours.end} ({c.callingHours.tz}) · up to {c.maxAttempts} attempts, {c.retryGapMinutes} min apart. The board refreshes every 15 seconds.
          </p>
        </div>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">{t.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">{t.value}</p>
            </div>
          ))}
        </section>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0F0F0F] dark:text-[#A1A1AA]">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">On a lead</th>
                <th className="px-3 py-2 text-right font-medium">Calls today</th>
              </tr>
            </thead>
            <tbody>
              {board.agents.map((a) => (
                <tr key={a.userId} className="border-t border-slate-100 dark:border-[#181818]">
                  <td className="px-3 py-2">{names.get(a.userId) ?? a.userId}</td>
                  <td className="px-3 py-2 capitalize">{a.status.replace('_', ' ')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.holding ? 'Yes' : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.callsToday}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    );
  });
}
