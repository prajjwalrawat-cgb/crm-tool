'use client';

import { Loader2, Phone, Plus, Users, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

import { logDealActivityAction } from '../actions';

/**
 * Compact launcher for manually logging a call/meeting that didn't come
 * through an integration. Writes to `activity_logs` via `logDealActivityAction`
 * so the entry lands in the same Activity feed the AI analysis reads.
 */
export function LogActivityLauncher({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'call' | 'meeting'>('call');
  const [occurredAt, setOccurredAt] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      const result = await logDealActivityAction({
        dealId,
        type,
        occurredAt: occurredAt || null,
        notes: notes.trim() || null,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`${type === 'call' ? 'Call' : 'Meeting'} logged`);
      setOpen(false);
      setNotes('');
      setOccurredAt('');
      setType('call');
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Log activity
      </button>
    );
  }

  return (
    <div className="absolute left-0 top-8 z-20 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-slate-800">
          Log activity
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-slate-400 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        {(['call', 'meeting'] as const).map((t) => {
          const Icon = t === 'call' ? Phone : Users;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={cn(
                'flex items-center justify-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium capitalize transition',
                type === t
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300',
              )}
            >
              <Icon className="h-3 w-3" aria-hidden />
              {t}
            </button>
          );
        })}
      </div>

      <label className="mb-2 flex flex-col gap-0.5">
        <span className="text-[9px] font-medium uppercase tracking-wide text-slate-400">
          Date
        </span>
        <input
          type="date"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          className="w-full rounded border border-slate-200 px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
        />
      </label>

      <label className="mb-2 flex flex-col gap-0.5">
        <span className="text-[9px] font-medium uppercase tracking-wide text-slate-400">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What happened on the call/meeting?"
          className="w-full resize-none rounded border border-slate-200 px-1.5 py-1 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
        />
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-2 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : null}
          Log
        </button>
      </div>
    </div>
  );
}
