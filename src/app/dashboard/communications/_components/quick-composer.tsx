'use client';

import { CheckCircle2, Loader2, RefreshCw, ServerCrash } from 'lucide-react';
import { useCallback } from 'react';

import { useDraftAutosave } from '@/hooks/use-draft-autosave';
import type { DraftSnapshot } from '@/lib/communications/drafts/types';
import { cn } from '@/lib/utils';

import {
  getDraftAction,
  saveDraftAction,
} from '../actions';

/**
 * Minimal "new draft" composer (CP#16C-B foundation slice). No
 * formatting toolbar, no slash commands, no attachments — those land
 * in CP#16C-C. The point of this is to exercise the autosave
 * pipeline end to end and give the user a working entry point.
 *
 * The composer holds NO local state of its own — every change goes
 * through `useDraftAutosave` which is the single source of truth.
 * That way a multi-tab edit + reconnect arrives at a consistent
 * server-side row.
 */
export function QuickComposer({
  tenantId,
  currentUserId,
  initialDraft,
}: {
  tenantId: string;
  currentUserId: string;
  initialDraft: DraftSnapshot | null;
}) {
  const reload = useCallback(async () => {
    const result = await getDraftAction({ contextKind: 'new' });
    return { draft: result.draft ?? null };
  }, []);

  const { draft, state, updateField } = useDraftAutosave({
    tenantId,
    currentUserId,
    contextKind: 'new',
    initial: initialDraft,
    save: (input) => saveDraftAction(input),
    reload,
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Quick draft
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
            Type below — we autosave every few seconds. Send pipeline lands in the next checkpoint.
          </p>
        </div>
        <SaveStateBadge state={state} />
      </header>

      <div className="space-y-2.5">
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            To
          </span>
          <input
            type="text"
            value={(draft?.toRecipients ?? []).join(', ')}
            onChange={(e) =>
              updateField(
                'toRecipients',
                e.target.value
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            }
            placeholder="alice@example.com, bob@example.com"
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
          />
        </label>

        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Subject
          </span>
          <input
            type="text"
            value={draft?.subject ?? ''}
            onChange={(e) => updateField('subject', e.target.value)}
            placeholder="Re: Pricing question"
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
          />
        </label>

        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Body
          </span>
          <textarea
            value={draft?.bodyText ?? ''}
            onChange={(e) => updateField('bodyText', e.target.value)}
            placeholder="Write your message…"
            rows={6}
            className="mt-1 w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
          />
        </label>
      </div>
    </section>
  );
}

function SaveStateBadge({
  state,
}: {
  state:
    | 'idle'
    | 'pending'
    | 'saving'
    | 'saved'
    | 'stale'
    | 'error';
}) {
  const styles: Record<typeof state, string> = {
    idle: 'text-slate-400 dark:text-[#71717A]',
    pending: 'text-amber-600 dark:text-amber-300',
    saving: 'text-indigo-600 dark:text-indigo-300',
    saved: 'text-emerald-600 dark:text-emerald-300',
    stale: 'text-amber-700 dark:text-amber-300',
    error: 'text-rose-700 dark:text-rose-300',
  };
  const label: Record<typeof state, string> = {
    idle: 'Idle',
    pending: 'Edits pending…',
    saving: 'Saving…',
    saved: 'Saved',
    stale: 'Reloaded from another tab',
    error: 'Save failed',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium tabular-nums',
        styles[state],
      )}
      aria-live="polite"
    >
      {state === 'saving' ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : state === 'saved' ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden />
      ) : state === 'stale' ? (
        <RefreshCw className="h-3 w-3" aria-hidden />
      ) : state === 'error' ? (
        <ServerCrash className="h-3 w-3" aria-hidden />
      ) : null}
      {label[state]}
    </span>
  );
}
