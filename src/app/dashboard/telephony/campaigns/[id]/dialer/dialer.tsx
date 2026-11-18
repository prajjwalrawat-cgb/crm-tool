'use client';

import { Loader2, Phone, SkipForward } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';

import { dialCampaignItem, getSoftphoneState, pullNextLead, skipCampaignItem, type DialerLead } from '../../../actions';
import { CALL_STARTED_EVENT } from '../../../../_components/telephony/click-to-call-button';

/**
 * Agent dialer. Claims one lead at a time (server-side FOR UPDATE SKIP LOCKED,
 * so two agents never get the same lead). The disposition itself is collected
 * by the global softphone bar's modal; when it is saved the call is no longer
 * pending and — in progressive mode, while the agent is Available — the next
 * lead is pulled and dialled automatically.
 */
export function Dialer({
  tenantId,
  currentUserId,
  campaignId,
  mode,
  status,
}: {
  tenantId: string;
  currentUserId: string;
  campaignId: string;
  mode: 'preview' | 'progressive';
  status: string;
}) {
  const [lead, setLead] = useState<DialerLead | null>(null);
  const [empty, setEmpty] = useState(false);
  const [onCall, setOnCall] = useState(false);
  const [pending, startTransition] = useTransition();
  const awaitingWrapUp = useRef(false);

  const pull = useCallback(
    (autoDial: boolean) =>
      startTransition(async () => {
        const r = await pullNextLead(campaignId);
        if (!r.ok) return void toast.error(r.message);
        setLead(r.next);
        setEmpty(!r.next);
        if (r.next && autoDial) {
          const s = await getSoftphoneState();
          if (s.ok && s.state.agentStatus === 'available' && !s.state.pendingDisposition && !s.state.activeCall) {
            const d = await dialCampaignItem(r.next.item.id);
            if (!d.ok) return void toast.error(d.message);
            setOnCall(true);
            awaitingWrapUp.current = true;
            window.dispatchEvent(new CustomEvent(CALL_STARTED_EVENT, { detail: { callId: d.callId } }));
          }
        }
      }),
    [campaignId],
  );

  useEffect(() => {
    if (status === 'running') pull(false);
  }, [pull, status]);

  // Wrap-up finished = the call ended AND its disposition was saved.
  useRealtimeEventOfType(tenantId, 'call.updated', (e) => {
    if (e.recipientUserId !== currentUserId) return;
    if (e.endedAt) setOnCall(false);
  });
  useEffect(() => {
    if (!awaitingWrapUp.current) return;
    const t = setInterval(async () => {
      const s = await getSoftphoneState();
      if (!s.ok) return;
      if (!s.state.activeCall && !s.state.pendingDisposition) {
        awaitingWrapUp.current = false;
        setOnCall(false);
        pull(mode === 'progressive');
      }
    }, 2500);
    return () => clearInterval(t);
  }, [onCall, mode, pull]);

  if (status !== 'running') {
    return <p className="rounded-md border border-slate-200 p-4 text-[13px] text-slate-500 dark:border-[#1F1F1F]">This campaign is {status}. A manager has to start it.</p>;
  }
  if (empty) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        Nothing to call right now — the queue is empty or every remaining lead is waiting for its retry gap.
        <div className="mt-3">
          <button type="button" onClick={() => pull(false)} className="rounded-md border border-slate-200 px-3 py-1 text-[12px] dark:border-[#1F1F1F]">
            Check again
          </button>
        </div>
      </div>
    );
  }
  if (!lead) return <div className="h-40 animate-pulse rounded-lg bg-slate-100 dark:bg-[#0F0F0F]" />;

  const l = lead.lead;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">Attempt {lead.item.attempts + 1}</p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-[#FAFAFA]">{l.contactName ?? l.name}</h2>
      <p className="text-[13px] text-slate-600 dark:text-[#A1A1AA]">{[l.company, l.phone, l.stage].filter(Boolean).join(' · ')}</p>
      <Link href={`/dashboard/deals/${l.id}`} target="_blank" className="mt-1 inline-block text-[12px] text-indigo-600 hover:underline dark:text-indigo-300">
        Open lead in a new tab
      </Link>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          disabled={pending || onCall}
          onClick={() =>
            startTransition(async () => {
              const d = await dialCampaignItem(lead.item.id);
              if (!d.ok) return void toast.error(d.message);
              setOnCall(true);
              awaitingWrapUp.current = true;
              window.dispatchEvent(new CustomEvent(CALL_STARTED_EVENT, { detail: { callId: d.callId } }));
              toast.success('Calling… your phone will ring first.');
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Phone className="h-4 w-4" aria-hidden />}
          {onCall ? 'On call…' : 'Call'}
        </button>
        <button
          type="button"
          disabled={pending || onCall}
          onClick={() =>
            startTransition(async () => {
              await skipCampaignItem(lead.item.id, null);
              pull(false);
            })
          }
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-2 text-[13px] text-slate-600 hover:border-slate-300 disabled:opacity-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA]"
        >
          <SkipForward className="h-4 w-4" aria-hidden /> Skip
        </button>
      </div>
      <p className="mt-3 text-[11px] text-slate-400">The disposition form appears automatically when the call ends.</p>
    </div>
  );
}
