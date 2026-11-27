'use client';

import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { MAX_SOURCES, prospectSourcesError } from '@/lib/prospects/rules';

import { saveProspectSources } from '../actions';

const box = 'rounded-lg border border-slate-200 p-4 dark:border-[#1F1F1F]';
const input =
  'w-full rounded-md border border-slate-300 px-2 py-1 text-[13px] dark:border-[#2A2A2A] dark:bg-transparent dark:text-[#E4E4E7]';
const iconBtn =
  'rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30 dark:hover:bg-[#1F1F1F]';

/** Owner/admin editor for the Source dropdown on New prospect and Quick dump. */
export function ProspectSourcesForm({ initial }: { initial: string[] }) {
  const [sources, setSources] = useState<string[]>(initial);
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const setAt = (i: number, v: string) => setSources((l) => l.map((s, j) => (j === i ? v : s)));
  const move = (i: number, d: -1 | 1) =>
    setSources((l) => {
      const n = [...l];
      [n[i], n[i + d]] = [n[i + d]!, n[i]!];
      return n;
    });

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (sources.some((s) => s.trim().toLowerCase() === v.toLowerCase())) return void toast.error('That source is already in the list.');
    setSources((l) => [...l, v]);
    setDraft('');
  }

  function save() {
    const list = sources.map((s) => s.trim());
    const invalid = prospectSourcesError(list);
    if (invalid) return void toast.error(invalid);
    start(async () => {
      const r = await saveProspectSources(list);
      if (!r.ok) return void toast.error(r.message);
      toast.success('Sources saved');
      router.refresh();
    });
  }

  return (
    <div className={box}>
      <p className="text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]">Sources</p>
      <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Where a prospect came from. These are the choices in the Source dropdown when adding a prospect or using Quick
        dump. Renaming or removing one does not change prospects that already have it.
      </p>
      <ul className="mt-3 space-y-1.5">
        {sources.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              aria-label={`Source ${i + 1}`}
              className={input}
              value={s}
              maxLength={80}
              disabled={pending}
              onChange={(e) => setAt(i, e.target.value)}
            />
            <button type="button" aria-label="Move up" className={iconBtn} disabled={pending || i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Move down"
              className={iconBtn}
              disabled={pending || i === sources.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="size-4" />
            </button>
            <button
              type="button"
              aria-label={`Remove ${s || 'source'}`}
              className={iconBtn}
              disabled={pending || sources.length <= 1}
              onClick={() => setSources((l) => l.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {sources.length < MAX_SOURCES ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            aria-label="New source"
            placeholder="Add a source, e.g. Trade show"
            className={input}
            value={draft}
            maxLength={80}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending || !draft.trim()}
            className="shrink-0 rounded-md border border-slate-300 px-3 py-1 text-[13px] text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-[#2A2A2A] dark:text-[#E4E4E7]"
          >
            Add
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save sources'}
      </button>
    </div>
  );
}
