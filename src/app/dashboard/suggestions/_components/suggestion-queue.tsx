'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { LOW_CONFIDENCE, type SuggestionView } from '@/lib/ai/suggestions/view';

import { bulkDecideSuggestions } from '../actions';
import { SuggestionItem } from './suggestion-item';

/** Review queue with select-all and bulk accept / reject. Low-confidence items start collapsed. */
export function SuggestionQueue({ items }: { items: SuggestionView[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const strong = items.filter((i) => i.confidence >= LOW_CONFIDENCE);
  const weak = items.filter((i) => i.confidence < LOW_CONFIDENCE);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const bulk = (action: 'accept' | 'reject') =>
    start(async () => {
      const r = await bulkDecideSuggestions([...selected], action);
      const done = action === 'accept' ? r.accepted : r.rejected;
      if (done) toast.success(`${done} suggestion${done === 1 ? '' : 's'} ${action === 'accept' ? 'accepted' : 'rejected'}`);
      if (r.failed.length) toast.error(`${r.failed.length} could not be ${action}ed: ${r.failed[0]!.message}`);
      setSelected(new Set());
      router.refresh();
    });

  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500 dark:border-[#262626]">Nothing to review.</p>;
  }

  const list = (xs: SuggestionView[]) => (
    <ul className="space-y-2">
      {xs.map((s) => (
        <SuggestionItem key={s.id} s={s} showEntity selectable={{ checked: selected.has(s.id), onChange: (v) => toggle(s.id, v) }} />
      ))}
    </ul>
  );

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-[12px] backdrop-blur dark:border-[#1F1F1F] dark:bg-black/90">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={selected.size > 0 && selected.size === strong.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(strong.map((s) => s.id)) : new Set())}
          />
          Select all{weak.length ? ' (except low-confidence)' : ''}
        </label>
        <span className="text-slate-400">{selected.size} selected</span>
        <button
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => bulk('accept')}
          className="ml-auto inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />} Accept selected
        </button>
        <button
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => bulk('reject')}
          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-[#262626] dark:text-[#E4E4E7]"
        >
          <X className="h-3 w-3" aria-hidden /> Reject selected
        </button>
      </div>
      {list(strong)}
      {weak.length ? (
        <details className="rounded-md border border-slate-200 p-3 dark:border-[#1F1F1F]">
          <summary className="cursor-pointer text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">
            {weak.length} low-confidence suggestion{weak.length === 1 ? '' : 's'} (under {Math.round(LOW_CONFIDENCE * 100)}%)
          </summary>
          <div className="mt-2">{list(weak)}</div>
        </details>
      ) : null}
    </div>
  );
}
