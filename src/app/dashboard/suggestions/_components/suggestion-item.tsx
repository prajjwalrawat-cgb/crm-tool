'use client';

import { ArrowRight, Check, ExternalLink, Loader2, Mail, Pencil, Phone, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { FollowUpValue, SuggestionValue } from '@/db/schema/ai-suggestions';
import { formatSuggestionValue, type SuggestionView } from '@/lib/ai/suggestions/view';
import { SIZE_BANDS } from '@/lib/prospects/rules';

import { acceptSuggestion, editAndAcceptSuggestion, rejectSuggestion } from '../actions';

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'hold', 'won', 'lost'];

type Stale = { atSuggestion: SuggestionValue; live: SuggestionValue; suggested: SuggestionValue };

/** One AI suggestion with Accept / Edit / Reject. Used on the deal card and the review queue. */
export function SuggestionItem({
  s,
  showEntity = false,
  selectable,
}: {
  s: SuggestionView;
  showEntity?: boolean;
  selectable?: { checked: boolean; onChange: (v: boolean) => void };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [stale, setStale] = useState<Stale | null>(null);
  const [done, setDone] = useState<null | 'accepted' | 'rejected'>(null);
  const [draft, setDraft] = useState<string>(() => (typeof s.suggested === 'object' && s.suggested ? (s.suggested as FollowUpValue).title : String(s.suggested ?? '')));
  const [draftDate, setDraftDate] = useState<string>(() => (typeof s.suggested === 'object' && s.suggested ? (s.suggested as FollowUpValue).due_date : ''));

  const act = (fn: () => ReturnType<typeof acceptSuggestion>, okMsg: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setDone(r.status);
        toast.success(okMsg);
        router.refresh();
        return;
      }
      if ('stale' in r && r.stale) {
        setStale({ atSuggestion: r.atSuggestion, live: r.live, suggested: r.suggested });
        toast.warning(r.message);
        router.refresh();
        return;
      }
      toast.error(r.message);
    });

  const editValue = () => (s.field === 'follow_up_task' ? { title: draft, due_date: draftDate } : s.field === 'amount' ? Number(draft) : draft);
  // Product fit picks from the active offerings; with none there is nothing to edit to.
  const choices: Array<{ value: string; label: string }> | null =
    s.field === 'size_band' ? SIZE_BANDS.map((b) => ({ value: b, label: b })) : s.field === 'product_fit' ? (s.options ?? []) : null;
  const canEdit = !(s.field === 'product_fit' && (choices?.length ?? 0) === 0);
  const pct = Math.round(s.confidence * 100);
  const SourceIcon = s.sourceType === 'call' ? Phone : s.sourceType === 'email' ? Mail : Sparkles;

  if (done) {
    return (
      <li className="rounded-md border border-slate-200 px-3 py-2 text-[12px] text-slate-500 dark:border-[#1F1F1F]">
        {s.fieldLabel}: {done === 'accepted' ? 'accepted and applied' : 'rejected'}.
      </li>
    );
  }

  return (
    <li className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {selectable ? (
          <input type="checkbox" aria-label={`Select ${s.fieldLabel}`} checked={selectable.checked} onChange={(e) => selectable.onChange(e.target.checked)} />
        ) : null}
        <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
        <span className="font-semibold text-slate-800 dark:text-[#E4E4E7]">{s.fieldLabel}</span>
        {showEntity && s.entityName ? (
          <Link href={s.entityHref ?? '#'} className="text-slate-500 hover:underline">
            · {s.entityName}
          </Link>
        ) : null}
        <span
          className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${pct >= 80 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : pct >= 60 ? 'bg-slate-100 text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}
          title="How sure the AI is, from the wording of the conversation"
        >
          {pct}% confident
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-slate-700 dark:text-[#E4E4E7]">
        <span className="text-slate-500 line-through decoration-slate-300 dark:text-[#71717A]">{formatSuggestionValue(s.field, s.current, s.valueLabels)}</span>
        <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
        <span className="font-medium">{formatSuggestionValue(s.field, s.suggested, s.valueLabels)}</span>
      </div>

      <blockquote className="mt-1.5 border-l-2 border-indigo-200 pl-2 italic text-slate-600 dark:border-indigo-500/40 dark:text-[#A1A1AA]">
        “{s.evidence}”
      </blockquote>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
        <SourceIcon className="h-3 w-3" aria-hidden />
        From {s.sourceType === 'call' ? 'a call' : s.sourceType === 'email' ? 'an email' : 'AI enrichment'}
        {s.sourceHref ? (
          <Link href={s.sourceHref} className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-300">
            view <ExternalLink className="h-2.5 w-2.5" aria-hidden />
          </Link>
        ) : null}
        · AI-generated, check before accepting
      </p>

      {stale ? (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" role="alert">
          <p className="font-medium">This field changed after the suggestion was made, so nothing was overwritten.</p>
          <p>When suggested: {formatSuggestionValue(s.field, stale.atSuggestion, s.valueLabels)}</p>
          <p>Now: {formatSuggestionValue(s.field, stale.live, s.valueLabels)}</p>
          <p>Suggested: {formatSuggestionValue(s.field, stale.suggested, s.valueLabels)}</p>
        </div>
      ) : null}

      {editing && !stale ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {s.field === 'stage' ? (
            <select className="rounded border border-slate-300 px-1.5 py-1 dark:border-[#262626] dark:bg-black" value={draft} onChange={(e) => setDraft(e.target.value)}>
              {STAGES.map((st) => (
                <option key={st} value={st}>
                  {formatSuggestionValue('stage', st)}
                </option>
              ))}
            </select>
          ) : choices ? (
            <select className="rounded border border-slate-300 px-1.5 py-1 dark:border-[#262626] dark:bg-black" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New ${s.fieldLabel}`}>
              {choices.some((c) => c.value === draft) ? null : <option value={draft}>{formatSuggestionValue(s.field, draft, s.valueLabels)}</option>}
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : s.field === 'close_date' ? (
            <input type="date" className="rounded border border-slate-300 px-1.5 py-1 dark:border-[#262626] dark:bg-black" value={draft} onChange={(e) => setDraft(e.target.value)} />
          ) : (
            <input
              className="min-w-[12rem] flex-1 rounded border border-slate-300 px-1.5 py-1 dark:border-[#262626] dark:bg-black"
              value={draft}
              inputMode={s.field === 'amount' ? 'decimal' : s.field === 'icp_score' ? 'numeric' : undefined}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`New ${s.fieldLabel}`}
            />
          )}
          {s.field === 'follow_up_task' ? (
            <input type="date" className="rounded border border-slate-300 px-1.5 py-1 dark:border-[#262626] dark:bg-black" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} aria-label="Due date" />
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => editAndAcceptSuggestion(s.id, editValue()), 'Saved')}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />} Save and accept
          </button>
          <button type="button" onClick={() => setEditing(false)} className="px-1.5 py-1 text-slate-500 hover:text-slate-800">
            Cancel
          </button>
        </div>
      ) : null}

      {!editing && !stale ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => acceptSuggestion(s.id), 'Suggestion accepted')}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />} Accept
          </button>
          {canEdit ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-[#262626] dark:text-[#E4E4E7]"
            >
              <Pencil className="h-3 w-3" aria-hidden /> Edit
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => rejectSuggestion(s.id), 'Suggestion rejected')}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-[#262626] dark:text-[#E4E4E7]"
          >
            <X className="h-3 w-3" aria-hidden /> Reject
          </button>
        </div>
      ) : null}
    </li>
  );
}
