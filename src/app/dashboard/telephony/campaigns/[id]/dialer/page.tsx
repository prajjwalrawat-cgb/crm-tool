import { notFound } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { getCampaignBoard } from '@/lib/telephony/campaigns';

import { Dialer } from './dialer';

export const metadata = { title: 'Dialer' };

type Params = Promise<{ id: string }>;

export default async function DialerPage({ params }: { params: Params }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const { id } = await params;
    const board = await getCampaignBoard(tenant.id, id);
    if (!board || !board.campaign.agentIds.includes(userId)) notFound();
    return (
      <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">{board.campaign.name}</h1>
          <p className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            {board.campaign.mode === 'progressive'
              ? 'Progressive: after you save a disposition, the next lead is dialled automatically while you are Available.'
              : 'Preview: review the lead, then press Call.'}
          </p>
        </header>
        <Dialer tenantId={tenant.id} currentUserId={userId} campaignId={id} mode={board.campaign.mode} status={board.campaign.status} />
      </main>
    );
  });
}
