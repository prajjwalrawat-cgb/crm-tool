import Link from 'next/link';
import { AlertTriangle, ArrowRight, BrainCircuit, Mail, ListTodo, RefreshCw, UserCog, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  DailyExecSummary,
  DealAiSummary,
  PipelineSummary,
  Recommendation,
  RiskFlag,
  RiskSeverity,
} from '@/lib/intelligence/types';

/**
 * Per-insight-type body components. The card primitive renders chrome;
 * these render the actual content. They're plain server components
 * (no client interactivity) so the page can stream them.
 */

export function DailyExecBody({ data }: { data: DailyExecSummary | null }) {
  if (!data) return <EmptyBody label="No summary yet. Refreshing in the background…" />;
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
        {data.headline}
      </p>
      {data.bullets.length > 0 ? (
        <ul className="space-y-1 text-[12.5px] leading-snug text-slate-600 dark:text-[#A1A1AA]">
          {data.bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-indigo-500"
                aria-hidden
              />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.callout ? (
        <div
          className={cn(
            'mt-1 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px]',
            calloutTone[data.callout.severity],
          )}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <div>
            <div className="font-medium">{data.callout.title}</div>
            <div className="opacity-90">{data.callout.detail}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const calloutTone: Record<RiskSeverity, string> = {
  info: 'border-indigo-200 bg-indigo-50/60 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300',
  warning:
    'border-amber-200 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  danger:
    'border-rose-200 bg-rose-50/60 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
};

export function RiskFlagsBody({ flags }: { flags: RiskFlag[] }) {
  if (flags.length === 0)
    return <EmptyBody label="Nothing flagged. Pipeline looks healthy." />;
  return (
    <ul className="space-y-2">
      {flags.map((f, i) => (
        <li
          key={i}
          className="flex items-start gap-2.5 rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-2 dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
        >
          <span
            className={cn(
              'mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full',
              severityDot[f.severity],
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              {f.entity ? (
                <Link
                  href={`/dashboard/deals/${f.entity.id}`}
                  className="truncate text-[12.5px] font-semibold text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                >
                  {f.entity.name}
                </Link>
              ) : (
                <span className="text-[12.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                  {f.title}
                </span>
              )}
              <span className="font-mono text-[10px] tabular-nums text-slate-400 dark:text-[#A1A1AA]">
                {Math.round(f.confidence * 100)}%
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-slate-600 dark:text-[#A1A1AA]">
              {f.reason}
            </p>
            {f.signals.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {f.signals.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-slate-100 px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]"
                  >
                    {s.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

const severityDot: Record<RiskSeverity, string> = {
  info: 'bg-indigo-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

export function RecommendationsBody({
  recommendations,
}: {
  recommendations: Recommendation[];
}) {
  if (recommendations.length === 0)
    return (
      <EmptyBody label="No recommendations right now. You're caught up." />
    );
  return (
    <ul className="space-y-2">
      {recommendations.map((r, i) => {
        const Icon = actionIcon[r.actionKind];
        return (
          <li
            key={i}
            className="rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-2 dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
          >
            <div className="flex items-start gap-2.5">
              <span
                className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300"
                aria-hidden
              >
                <Icon className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/dashboard/deals/${r.entity.id}`}
                    className="truncate text-[12.5px] font-semibold text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                  >
                    {r.title}
                  </Link>
                  <Link
                    href={`/dashboard/deals/${r.entity.id}`}
                    aria-label="Open deal"
                    className="text-slate-400 hover:text-indigo-600 dark:text-[#A1A1AA] dark:hover:text-indigo-300"
                  >
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-slate-600 dark:text-[#A1A1AA]">
                  {r.rationale}
                </p>
                {r.suggestion?.text ? (
                  <div className="mt-1 truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
                    Draft: {r.suggestion.text}
                  </div>
                ) : null}
                {r.patternSource && r.patternSource.length > 0 ? (
                  <PatternSource sources={r.patternSource} />
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Why am I seeing this?" affordance — renders the learned patterns
 * that contributed to a recommendation. Tooltip-style detail under
 * each chip explains the supporting sample size and observed delta.
 */
function PatternSource({
  sources,
}: {
  sources: NonNullable<Recommendation['patternSource']>;
}) {
  return (
    <div className="mt-1.5 rounded-md border border-indigo-100 bg-indigo-50/40 px-2 py-1.5 dark:border-indigo-500/20 dark:bg-indigo-500/5">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
        <BrainCircuit className="h-3 w-3" aria-hidden />
        Why am I seeing this?
      </div>
      <ul className="mt-1 space-y-0.5">
        {sources.map((s, i) => (
          <li
            key={i}
            className="text-[11px] leading-snug text-slate-600 dark:text-[#A1A1AA]"
            title={`${s.patternType} · ${Math.round(s.confidence * 100)}% confidence · n=${s.sampleSize}`}
          >
            <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
              {s.headline}
            </span>
            {s.detail ? (
              <span className="ml-1 text-slate-500 dark:text-[#71717A]">
                — {s.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const actionIcon = {
  send_email: Mail,
  create_task: ListTodo,
  reassign_owner: UserCog,
  update_stage: RefreshCw,
  add_note: FileText,
};

export function PipelineSummaryBody({
  data,
}: {
  data: PipelineSummary | null;
}) {
  if (!data)
    return <EmptyBody label="No pipeline narrative yet. Refreshing in the background…" />;
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
        {data.headline}
      </p>
      <ul className="space-y-1 text-[12px] leading-snug text-slate-600 dark:text-[#A1A1AA]">
        {data.bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-indigo-500"
              aria-hidden
            />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {data.bottlenecks.length > 0 ? (
        <div className="mt-1 rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <div className="font-medium">Bottlenecks</div>
          <ul className="mt-0.5 space-y-0.5">
            {data.bottlenecks.map((b, i) => (
              <li key={i}>
                <span className="font-mono text-[10.5px] uppercase tracking-wide">
                  {b.stage}
                </span>{' '}
                — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function DealSummaryBody({ data }: { data: DealAiSummary | null }) {
  if (!data) return <EmptyBody label="No summary yet. Refreshing in the background…" />;
  return (
    <div className="space-y-2.5">
      <p className="text-[12.5px] leading-snug text-slate-700 dark:text-[#FAFAFA]">
        {data.narrative}
      </p>
      {data.risks.length > 0 ? (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-300">
            Risks
          </div>
          <ul className="mt-0.5 space-y-0.5 text-[11.5px] text-slate-600 dark:text-[#A1A1AA]">
            {data.risks.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span
                  className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-rose-500"
                  aria-hidden
                />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.nextActions.length > 0 ? (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            Next actions
          </div>
          <ul className="mt-0.5 space-y-0.5 text-[11.5px] text-slate-600 dark:text-[#A1A1AA]">
            {data.nextActions.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span
                  className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-emerald-500"
                  aria-hidden
                />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex items-center justify-between border-t border-slate-200/60 pt-1.5 text-[10.5px] text-slate-500 dark:border-[#1F1F1F]/60 dark:text-[#A1A1AA]">
        <span>Model confidence</span>
        <span className="font-mono tabular-nums">
          {Math.round(data.confidence * 100)}%
        </span>
      </div>
    </div>
  );
}

function EmptyBody({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/40 px-3 py-3 text-center text-[11.5px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
      {label}
    </div>
  );
}
