import { ArrowDown } from 'lucide-react';

import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

/**
 * Stage Conversion Bars — replaces the giant trapezoid funnel with a
 * compact, scannable horizontal-bar layout. One row per stage:
 *
 *   [Stage label]   ████████████████░░░░  ₹1.2M   (84% from prev)
 *
 * No SVG polygons. No layered depth. Pure aligned rows that respect
 * the dashboard's vertical rhythm. The previous funnel was visually
 * dominant but data-light; this surface trades drama for density.
 *
 * Two passes per stage:
 *   1. width  = revenue / maxRevenue (relative comparison across stages)
 *   2. badge  = revenue / prevStage  (stage-to-stage conversion)
 *
 * Heuristic close-probability is shown at the right of each row for
 * the forecasting story (lead 10% → won 100%). Forward stages only —
 * 'lost' is excluded from the visualization.
 */

type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won';
const FORWARD_STAGES: readonly Stage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
];
const LABELS: Record<Stage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
};
const PROB: Record<Stage, number> = {
  lead: 0.1,
  qualified: 0.25,
  proposal: 0.5,
  negotiation: 0.75,
  won: 1.0,
};
const STAGE_BAR: Record<Stage, { light: string; dark: string }> = {
  lead: {
    light: 'bg-indigo-200',
    dark: 'dark:bg-indigo-400/30',
  },
  qualified: {
    light: 'bg-indigo-300',
    dark: 'dark:bg-indigo-400/45',
  },
  proposal: {
    light: 'bg-violet-400',
    dark: 'dark:bg-violet-400/55',
  },
  negotiation: {
    light: 'bg-amber-400',
    dark: 'dark:bg-amber-400/60',
  },
  won: {
    light: 'bg-emerald-500',
    dark: 'dark:bg-emerald-400/70',
  },
};

export function StageConversionBars({
  rows,
  formatCurrency,
  className,
  title = 'Pipeline by stage',
  subtitle = 'Revenue-weighted bars · stage-to-stage conversion',
}: {
  rows: PipelineByStageRow[];
  formatCurrency: (amountMinor: number) => string;
  className?: string;
  title?: string;
  subtitle?: string;
}) {
  const byStage = new Map<Stage, PipelineByStageRow>();
  for (const r of rows) {
    if ((FORWARD_STAGES as readonly string[]).includes(r.stage)) {
      byStage.set(r.stage as Stage, r);
    }
  }
  const ordered = FORWARD_STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        stageLabel: LABELS[s],
        count: 0,
        totalAmountMinor: 0,
      },
  );

  const maxRevenue = Math.max(...ordered.map((r) => r.totalAmountMinor), 1);

  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
          <ArrowDown className="h-3 w-3" aria-hidden />
          Conversion
        </div>
        <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          {title}
        </h2>
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
          {subtitle}
        </p>
      </header>

      <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
        {ordered.map((row, i) => {
          const stage = row.stage as Stage;
          const widthPct = (row.totalAmountMinor / maxRevenue) * 100;
          // Minimum visual width keeps the row scannable even at 0.
          const renderedWidth = Math.max(2, widthPct);
          const prev = i > 0 ? ordered[i - 1]! : null;
          const conversionPct =
            prev && prev.totalAmountMinor > 0
              ? Math.round((row.totalAmountMinor / prev.totalAmountMinor) * 100)
              : null;
          const conversionTone =
            conversionPct === null
              ? 'neutral'
              : conversionPct >= 60
                ? 'good'
                : conversionPct >= 30
                  ? 'warn'
                  : 'bad';
          const conversionClass = {
            good: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15',
            warn: 'text-amber-800 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15',
            bad: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15',
            neutral: 'text-slate-500 bg-slate-50 dark:text-[#A1A1AA] dark:bg-[#181818]',
          }[conversionTone];
          return (
            <li
              key={stage}
              className="flex items-center gap-3 px-5 py-2.5 text-[12px]"
            >
              <span className="w-24 flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-slate-600 dark:text-[#A1A1AA]">
                {LABELS[stage]}
              </span>
              <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-[#181818]">
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out',
                    STAGE_BAR[stage].light,
                    STAGE_BAR[stage].dark,
                  )}
                  style={{ width: `${renderedWidth}%` }}
                  aria-hidden
                />
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="font-mono text-[12.5px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                  {formatCurrency(row.totalAmountMinor)}
                </div>
                <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] text-slate-500 dark:text-[#A1A1AA]">
                  <span>
                    {row.count} {row.count === 1 ? 'deal' : 'deals'}
                  </span>
                  <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
                  <span>{Math.round(PROB[stage] * 100)}% close</span>
                </div>
              </div>
              <div className="w-20 flex-shrink-0 text-right">
                {conversionPct !== null ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums',
                      conversionClass,
                    )}
                    title={`${conversionPct}% of ${LABELS[ordered[i - 1]!.stage as Stage]} revenue carries forward`}
                  >
                    {conversionPct}%
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-300 dark:text-[#3F3F46]">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
