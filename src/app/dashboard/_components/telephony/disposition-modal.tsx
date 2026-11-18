'use client';

import { Loader2, PhoneCall } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { CallDisposition } from '@/db/schema/telephony';
import { DISPOSITION_LABELS, formatDuration, type SerializedCall } from '@/lib/telephony/serialize';
import { cn } from '@/lib/utils';

import { submitDisposition } from '../../telephony/actions';

const CHOICES: CallDisposition[] = ['connected', 'interested', 'not_interested', 'callback', 'not_reachable', 'wrong_number', 'do_not_call'];

/**
 * Shown automatically when a call ends. It cannot be dismissed (no close
 * button, no Escape, no backdrop click) until a disposition is saved; "Skip"
 * exists only for calls shorter than `skipMaxSec` that never really connected.
 */
export function DispositionModal({
  call,
  leadName,
  skipMaxSec,
  onSaved,
}: {
  call: SerializedCall;
  leadName: string | null;
  skipMaxSec: number;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState<CallDisposition | null>(null);
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const [pending, startTransition] = useTransition();
  const secs = call.talkTimeSec ?? call.durationSec ?? 0;
  const canSkip = !call.answeredAt || secs < skipMaxSec;

  function save(d: CallDisposition) {
    startTransition(async () => {
      const r = await submitDisposition({
        callId: call.id,
        disposition: d,
        notes: notes.trim() || null,
        callbackAt: d === 'callback' && callbackAt ? new Date(callbackAt).toISOString() : null,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(d === 'callback' ? 'Saved — callback task created' : d === 'do_not_call' ? 'Saved — number added to do-not-call' : 'Disposition saved');
      onSaved();
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-labelledby="disposition-title">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <div className="mb-3 flex items-start gap-2.5">
          <span className="mt-0.5 rounded-md bg-indigo-50 p-1.5 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <PhoneCall className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="disposition-title" className="text-[14px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              How did the call go?
            </h2>
            <p className="truncate text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              {leadName ?? (call.direction === 'outbound' ? call.toNumber : call.fromNumber)} · {call.status.replace('_', ' ')} · {formatDuration(secs)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {CHOICES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setChoice(d)}
              aria-pressed={choice === d}
              className={cn(
                'rounded-md border px-2.5 py-1.5 text-left text-[12px] font-medium transition',
                choice === d
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500/50 dark:bg-indigo-500/10 dark:text-indigo-200'
                  : 'border-slate-200 text-slate-700 hover:border-slate-300 dark:border-[#1F1F1F] dark:text-[#E4E4E7]',
                d === 'do_not_call' && choice !== d && 'text-rose-700 dark:text-rose-300',
              )}
            >
              {DISPOSITION_LABELS[d]}
            </button>
          ))}
        </div>

        {choice === 'callback' ? (
          <label className="mt-3 block text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Call back at
            <input
              type="datetime-local"
              value={callbackAt}
              onChange={(e) => setCallbackAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-black"
            />
          </label>
        ) : null}
        {choice === 'do_not_call' ? (
          <p className="mt-2 text-[11px] text-rose-700 dark:text-rose-300">This number will be added to the do-not-call list and removed from dialer campaigns.</p>
        ) : null}

        <label className="mt-3 block text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-black"
            placeholder="What was discussed, what's next…"
          />
        </label>

        <div className="mt-4 flex items-center justify-between gap-2">
          {canSkip ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => save('skipped')}
              className="text-[12px] text-slate-500 hover:text-slate-700 dark:text-[#A1A1AA]"
            >
              Skip (no conversation)
            </button>
          ) : (
            <span className="text-[11px] text-slate-400">A disposition is required for this call.</span>
          )}
          <button
            type="button"
            disabled={!choice || pending || (choice === 'callback' && !callbackAt)}
            onClick={() => choice && save(choice)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Save disposition
          </button>
        </div>
      </div>
    </div>
  );
}
