'use client';

import { Sparkles, RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { generateDealSummaryAction } from '../actions';

type Props = {
  dealId: string;
  initialSummary: string | null;
  initialGeneratedAt: string | null;
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * AI-generated deal summary card. The first render shows whatever's
 * cached in `ai_summaries`. Clicking *Generate* (or *Regenerate*) calls
 * the server action — which short-circuits to the cached row when source
 * content is unchanged, so a "regenerate" click on a fresh deal doesn't
 * spend tokens.
 */
export function SummaryCard({
  dealId,
  initialSummary,
  initialGeneratedAt,
}: Props) {
  const [summary, setSummary] = useState<string | null>(initialSummary);
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    initialGeneratedAt,
  );
  const [pending, startTransition] = useTransition();

  const onGenerate = () => {
    startTransition(async () => {
      const result = await generateDealSummaryAction({
        dealId,
        // Force when the user clicks regenerate on an existing summary.
        // Otherwise the action's hash check would just hand back the same
        // cached text and the user would think the button was broken.
        force: Boolean(summary),
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setSummary(result.summary);
      setGeneratedAt(result.generatedAt);
      toast.success(result.cached ? 'Summary up to date' : 'Summary refreshed');
    });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          AI summary
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3 w-3 ${pending ? 'animate-spin' : ''}`}
            aria-hidden
          />
          {summary ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      <div className="mt-3 text-sm leading-relaxed text-slate-700">
        {summary ? (
          <p className="whitespace-pre-wrap">{summary}</p>
        ) : (
          <p className="text-slate-500">
            Click <span className="font-medium">Generate</span> to produce an
            AI summary of this deal&apos;s state, momentum, and any open
            signals from recent activity.
          </p>
        )}
      </div>

      {generatedAt ? (
        <p className="mt-3 text-[10px] uppercase tracking-wide text-slate-400">
          Generated {dateFormatter.format(new Date(generatedAt))}
        </p>
      ) : null}
    </section>
  );
}
