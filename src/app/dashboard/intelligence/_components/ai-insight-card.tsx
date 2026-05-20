'use client';

import {
  Loader2,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import type { InsightState } from '@/lib/intelligence/types';

import { recordAiFeedbackAction } from '../actions';

/**
 * The visual primitive for every AI insight on the page. Renders:
 *   - a header with title + state badge
 *   - a body with the model output (caller-provided)
 *   - a footer with feedback buttons (👍 / 👎 / dismiss)
 *
 * State drives the badge color, the spinner visibility, and whether
 * feedback buttons are interactable. The card itself doesn't fetch
 * — the parent does that server-side and hands content + state down.
 *
 * Why a single primitive: 6 insight types × 4 places they could
 * appear = 24 layouts. One primitive with a content slot means we
 * tune chrome once.
 */
export type AiInsightCardProps = {
  title: string;
  /** Optional subtitle rendered under title. */
  subtitle?: string;
  state: InsightState;
  /** Summary row id needed by the feedback API. Null when no row yet. */
  summaryId: string | null;
  /** When the row was last generated. ISO string. */
  generatedAt?: string | null;
  /** Tone — drives the gradient + accent color of the chrome. */
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Optional action slot in the top-right (e.g. "See all"). */
  action?: ReactNode;
  /** The model output. Skeleton renders when omitted. */
  children?: ReactNode;
  /** If true, the feedback footer is hidden (used for aggregate cards). */
  hideFeedback?: boolean;
  className?: string;
};

export function AiInsightCard({
  title,
  subtitle,
  state,
  summaryId,
  generatedAt,
  tone = 'info',
  action,
  children,
  hideFeedback = false,
  className,
}: AiInsightCardProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-lg border shadow-[0_1px_0_rgba(15,23,42,0.04)] transition-all',
        toneChrome[tone],
        className,
      )}
    >
      <div className="relative flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-300"
              aria-hidden
            >
              <Sparkles className="h-3 w-3" />
            </span>
            <h3 className="truncate text-[13px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {title}
            </h3>
            <StateBadge state={state} />
          </div>
          {subtitle ? (
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ?? null}
      </div>

      <div className="px-4 pb-3 pt-2">
        {children ?? <CardSkeleton />}
      </div>

      {!hideFeedback ? (
        <div className="flex items-center justify-between border-t border-slate-200/70 bg-white/40 px-4 py-1.5 text-[11px] text-slate-500 dark:border-[#1F1F1F]/70 dark:bg-[#111111] dark:text-[#A1A1AA]">
          <span>
            {generatedAt
              ? `Updated ${formatRelative(generatedAt)}`
              : 'Awaiting first generation'}
          </span>
          <FeedbackButtons
            summaryId={summaryId}
            onDismissed={() => setDismissed(true)}
          />
        </div>
      ) : null}
    </article>
  );
}

const toneChrome: Record<NonNullable<AiInsightCardProps['tone']>, string> = {
  info: 'border-indigo-200/80 bg-gradient-to-br from-indigo-50/60 via-white to-white dark:border-indigo-500/30 dark:from-indigo-500/10 dark:via-[#111827] dark:to-[#111827]',
  success:
    'border-emerald-200/80 bg-gradient-to-br from-emerald-50/60 via-white to-white dark:border-emerald-500/30 dark:from-emerald-500/10 dark:via-[#111827] dark:to-[#111827]',
  warning:
    'border-amber-200/80 bg-gradient-to-br from-amber-50/60 via-white to-white dark:border-amber-500/30 dark:from-amber-500/10 dark:via-[#111827] dark:to-[#111827]',
  danger:
    'border-rose-200/80 bg-gradient-to-br from-rose-50/60 via-white to-white dark:border-rose-500/30 dark:from-rose-500/10 dark:via-[#111827] dark:to-[#111827]',
  neutral: 'border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
};

function StateBadge({ state }: { state: InsightState }) {
  switch (state) {
    case 'cached':
      return null; // Fresh — don't add visual noise.
    case 'stale':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
          <RefreshCw className="h-2.5 w-2.5 animate-spin" aria-hidden />
          Refreshing
        </span>
      );
    case 'generating':
      return (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-indigo-100 px-1.5 py-px text-[9.5px] font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
          <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
          Generating
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center rounded-full bg-rose-100 px-1.5 py-px text-[9.5px] font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
          Failed
        </span>
      );
    case 'mock':
      return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-px text-[9.5px] font-semibold text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
          Mock
        </span>
      );
    case 'budget':
      return (
        <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
          Budget hit
        </span>
      );
    case 'disabled':
      return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-px text-[9.5px] font-semibold text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
          AI off
        </span>
      );
  }
}

function CardSkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200 dark:bg-[#181818]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-slate-200 dark:bg-[#181818]" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200 dark:bg-[#181818]" />
    </div>
  );
}

function FeedbackButtons({
  summaryId,
  onDismissed,
}: {
  summaryId: string | null;
  onDismissed: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [verdict, setVerdict] = useState<'helpful' | 'not_helpful' | null>(
    null,
  );

  // No summary id = no row yet. Buttons are inert.
  if (!summaryId) {
    return (
      <span className="text-[10px] text-slate-400 dark:text-[#A1A1AA]">
        Feedback unlocks once the insight is generated.
      </span>
    );
  }

  function submit(next: 'helpful' | 'not_helpful' | 'dismissed') {
    if (pending) return;
    startTransition(async () => {
      const res = await recordAiFeedbackAction({
        summaryId: summaryId!,
        verdict: next,
      });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      if (next === 'dismissed') {
        onDismissed();
        return;
      }
      setVerdict(next);
    });
  }

  return (
    <div className="flex items-center gap-1">
      <FeedbackButton
        label="Helpful"
        active={verdict === 'helpful'}
        onClick={() => submit('helpful')}
        disabled={pending}
      >
        <ThumbsUp className="h-3 w-3" aria-hidden />
      </FeedbackButton>
      <FeedbackButton
        label="Not helpful"
        active={verdict === 'not_helpful'}
        onClick={() => submit('not_helpful')}
        disabled={pending}
      >
        <ThumbsDown className="h-3 w-3" aria-hidden />
      </FeedbackButton>
      <FeedbackButton
        label="Dismiss"
        active={false}
        onClick={() => submit('dismissed')}
        disabled={pending}
      >
        <X className="h-3 w-3" aria-hidden />
      </FeedbackButton>
    </div>
  );
}

function FeedbackButton({
  label,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-[#A1A1AA] dark:hover:bg-slate-800/60 dark:hover:text-slate-200',
        disabled && 'opacity-50',
      )}
    >
      {children}
    </button>
  );
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'just now';
  const diffSec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
