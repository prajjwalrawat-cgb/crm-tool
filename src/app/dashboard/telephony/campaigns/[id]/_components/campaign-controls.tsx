'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';

import { changeCampaignStatus } from '../../../actions';

/** Start / pause buttons + the board's 15-second auto refresh. */
export function CampaignControls({
  campaignId,
  status,
  canManage,
  canDial,
}: {
  campaignId: string;
  status: 'draft' | 'running' | 'paused' | 'completed';
  canManage: boolean;
  canDial: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [router]);

  const set = (s: 'running' | 'paused' | 'completed') =>
    startTransition(async () => {
      const r = await changeCampaignStatus(campaignId, s);
      if (!r.ok) return void toast.error(r.message);
      router.refresh();
    });

  const btn = 'rounded-md border border-slate-200 px-2.5 py-1 text-[12px] font-medium hover:border-slate-300 disabled:opacity-50 dark:border-[#1F1F1F]';
  return (
    <span className="flex items-center gap-2">
      {canManage && status !== 'running' && status !== 'completed' ? (
        <button type="button" className={`${btn} text-emerald-700`} disabled={pending} onClick={() => set('running')}>
          Start
        </button>
      ) : null}
      {canManage && status === 'running' ? (
        <button type="button" className={`${btn} text-amber-700`} disabled={pending} onClick={() => set('paused')}>
          Pause
        </button>
      ) : null}
      {canManage && status !== 'completed' ? (
        <button type="button" className={`${btn} text-slate-500`} disabled={pending} onClick={() => window.confirm('Mark this campaign completed?') && set('completed')}>
          Complete
        </button>
      ) : null}
      {canDial && status === 'running' ? (
        <Link href={`/dashboard/telephony/campaigns/${campaignId}/dialer`} className="rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-indigo-500">
          Open dialer
        </Link>
      ) : null}
    </span>
  );
}
