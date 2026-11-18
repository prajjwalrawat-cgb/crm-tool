'use client';

import { Headset, Phone, PhoneIncoming } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { AgentStatus } from '@/db/schema/telephony';
import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';
import { formatDuration } from '@/lib/telephony/serialize';
import { cn } from '@/lib/utils';

import { getSoftphoneState, setMyAgentStatus, type SoftphoneState } from '../../telephony/actions';
import { CALL_STARTED_EVENT } from './click-to-call-button';
import { DispositionModal } from './disposition-modal';
import { setTelephonyReady } from './telephony-ready';

const STATUS_LABEL: Record<AgentStatus, string> = { available: 'Available', on_break: 'On break', offline: 'Offline' };
const STATUS_DOT: Record<AgentStatus, string> = { available: 'bg-emerald-500', on_break: 'bg-amber-500', offline: 'bg-slate-400' };

/**
 * Softphone-lite bar, pinned to the bottom of the app for agents with a
 * mapped phone. Availability (Available / On break / Offline — also drives
 * lead routing availability), the live call with a timer, the enforced
 * disposition modal when a call ends, and the inbound-call popup.
 * Mute/hold live on the provider side, so there are none here.
 */
export function SoftphoneBar({ tenantId, currentUserId }: { tenantId: string; currentUserId: string }) {
  const router = useRouter();
  const [state, setState] = useState<SoftphoneState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await getSoftphoneState();
      if (r.ok) {
        setState(r.state);
        setTelephonyReady(r.state.configured && r.state.mapped);
      }
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onStart = () => void refresh();
    window.addEventListener(CALL_STARTED_EVENT, onStart);
    return () => window.removeEventListener(CALL_STARTED_EVENT, onStart);
  }, [refresh]);

  // Tick the timer and poll while a call is live (realtime is the fast path;
  // polling covers a dropped stream).
  const live = !!state?.activeCall;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(t);
      clearInterval(p);
    };
  }, [live, refresh]);

  useRealtimeEventOfType(tenantId, 'call.updated', (e) => {
    if (e.recipientUserId === currentUserId) void refresh();
  });

  useRealtimeEventOfType(tenantId, 'call.inbound', (e) => {
    if (e.recipientUserId !== currentUserId) return;
    const c = e.call;
    const who = c.contactName ?? c.leadName ?? c.fromNumber;
    toast.custom(
      (id) => (
        <div className="w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <div className="flex items-start gap-2">
            <PhoneIncoming className="mt-0.5 h-4 w-4 text-emerald-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">Incoming call · {who}</p>
              <p className="truncate text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                {[c.companyName, c.fromNumber].filter(Boolean).join(' · ')}
              </p>
              <p className="text-[11px] text-slate-400">
                {c.isNewLead ? 'Unknown number — a new lead was created' : c.lastInteraction ? `Last interaction ${new Date(c.lastInteraction).toLocaleString('en-IN')}` : 'No earlier interaction'}
              </p>
              {c.leadId ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.dismiss(id);
                    router.push(`/dashboard/deals/${c.leadId}`);
                  }}
                  className="mt-2 rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-indigo-500"
                >
                  {c.isNewLead ? 'Open new lead' : 'Open lead'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ),
      { duration: 30_000 },
    );
    void refresh();
  });

  if (!state || !state.configured || !state.mapped) return null;

  const call = state.activeCall;
  const elapsed = call?.answeredAt
    ? Math.max(0, Math.round((now - new Date(call.answeredAt).getTime()) / 1000))
    : call?.startedAt
      ? Math.max(0, Math.round((now - new Date(call.startedAt).getTime()) / 1000))
      : 0;

  function changeStatus(s: AgentStatus) {
    startTransition(async () => {
      const r = await setMyAgentStatus(s);
      if (!r.ok) toast.error(r.message);
      await refresh();
    });
  }

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-4 text-[12px] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <Headset className="h-4 w-4 text-slate-400" aria-hidden />
        <label className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[state.agentStatus])} aria-hidden />
          <span className="sr-only">Availability</span>
          <select
            value={state.agentStatus}
            disabled={pending}
            onChange={(e) => changeStatus(e.target.value as AgentStatus)}
            className="rounded border-none bg-transparent py-0 pl-0 pr-6 text-[12px] font-medium text-slate-700 focus:ring-0 dark:text-[#E4E4E7]"
          >
            {(Object.keys(STATUS_LABEL) as AgentStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="h-4 w-px bg-slate-200 dark:bg-[#1F1F1F]" aria-hidden />
        {call ? (
          <span className="flex min-w-0 items-center gap-2 text-slate-700 dark:text-[#E4E4E7]">
            <Phone className={cn('h-3.5 w-3.5', call.status === 'answered' ? 'text-emerald-600' : 'animate-pulse text-amber-500')} aria-hidden />
            <span className="truncate">
              {call.direction === 'outbound' ? 'Calling' : 'On call with'} {state.leadName ?? (call.direction === 'outbound' ? call.toNumber : call.fromNumber)}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-[#181818]">
              {call.status === 'answered' ? formatDuration(elapsed) : call.status}
            </span>
            {call.leadId ? (
              <Link href={`/dashboard/deals/${call.leadId}`} className="text-indigo-600 hover:underline dark:text-indigo-300">
                Open lead
              </Link>
            ) : null}
          </span>
        ) : (
          <span className="text-slate-400">No active call</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <Link href="/dashboard/telephony/campaigns" className="text-slate-500 hover:text-slate-800 dark:text-[#A1A1AA] dark:hover:text-[#FAFAFA]">
            Dialer
          </Link>
          <span className="hidden text-[11px] text-slate-400 sm:inline">Calls may be recorded</span>
        </span>
      </div>
      {state.pendingDisposition && !call ? (
        <DispositionModal
          key={state.pendingDisposition.id}
          call={state.pendingDisposition}
          leadName={state.leadName}
          skipMaxSec={state.skipMaxSec}
          onSaved={() => {
            void refresh();
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
