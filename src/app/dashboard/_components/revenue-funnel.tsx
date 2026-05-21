import { TrendingUp } from 'lucide-react';

import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

/**
 * Revenue-weighted funnel. The hero element on Sales Home. Width is
 * proportional to revenue, not count — large deals deserve visual
 * weight. Conversion percentages between consecutive stages render
 * on the right.
 *
 * Server-rendered SVG so the funnel is in the HTML on first paint;
 * no client hydration cost. Dark-mode tints come from inline style
 * because some Tailwind dark variants need actual color values for
 * SVG fill — using CSS variables keeps it simple.
 *
 * Design decisions:
 *   - Stage tints map to Saleinx palette (lead = indigo, qualified =
 *     indigo deeper, proposal = violet, negotiation = amber, won =
 *     emerald). Lost is excluded — this is forward-pipeline.
 *   - Empty stages still render a thin sliver so the rep sees "what
 *     would be here" without an awkward zero-width band.
 *   - Hover tooltip lives on the SVG <title> element — accessible
 *     out of the box, no client JS.
 */

const FUNNEL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won'] as const;
type FunnelStage = (typeof FUNNEL_STAGES)[number];

const STAGE_LABELS: Record<FunnelStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
};

const STAGE_TINT: Record<FunnelStage, { fill: string; darkFill: string; text: string }> = {
  lead: {
    fill: 'rgb(199 210 254)',
    darkFill: 'rgba(99, 102, 241, 0.32)',
    text: 'text-indigo-900 dark:text-indigo-100',
  },
  qualified: {
    fill: 'rgb(165 180 252)',
    darkFill: 'rgba(99, 102, 241, 0.45)',
    text: 'text-indigo-900 dark:text-indigo-50',
  },
  proposal: {
    fill: 'rgb(167 139 250)',
    darkFill: 'rgba(139, 92, 246, 0.55)',
    text: 'text-violet-50',
  },
  negotiation: {
    fill: 'rgb(252 211 77)',
    darkFill: 'rgba(245, 158, 11, 0.65)',
    text: 'text-amber-950 dark:text-amber-50',
  },
  won: {
    fill: 'rgb(110 231 183)',
    darkFill: 'rgba(16, 185, 129, 0.75)',
    text: 'text-emerald-950 dark:text-emerald-50',
  },
};

export function RevenueFunnel({
  rows,
  formatCurrency,
  className,
}: {
  rows: PipelineByStageRow[];
  /** Tenant-aware currency formatter from the parent. */
  formatCurrency: (amountMinor: number) => string;
  className?: string;
}) {
  // Pull just the forward stages in canonical order.
  const byStage = new Map<FunnelStage, PipelineByStageRow>();
  for (const r of rows) {
    if ((FUNNEL_STAGES as readonly string[]).includes(r.stage)) {
      byStage.set(r.stage as FunnelStage, r);
    }
  }
  const ordered = FUNNEL_STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        stageLabel: STAGE_LABELS[s],
        count: 0,
        totalAmountMinor: 0,
      },
  );

  const maxRevenue = Math.max(...ordered.map((r) => r.totalAmountMinor), 1);
  const totalRevenue = ordered.reduce((s, r) => s + r.totalAmountMinor, 0);
  const wonRevenue = ordered.find((r) => r.stage === 'won')?.totalAmountMinor ?? 0;

  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-gradient-to-br from-white via-white to-slate-50/60 p-5 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:from-[#0A0A0A] dark:via-[#0A0A0A] dark:to-[#000000]',
        className,
      )}
    >
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <TrendingUp className="h-3 w-3" aria-hidden />
            Revenue funnel
          </div>
          <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Where the money is moving
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Width is revenue, not deal count. Big deals get the room they deserve.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Pipeline value
          </div>
          <div className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
            {formatCurrency(totalRevenue)}
          </div>
          {wonRevenue > 0 ? (
            <div className="mt-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {formatCurrency(wonRevenue)} won
            </div>
          ) : null}
        </div>
      </header>

      <ul className="space-y-2">
        {ordered.map((row, i) => {
          const stage = row.stage as FunnelStage;
          const tint = STAGE_TINT[stage];
          const pct = (row.totalAmountMinor / maxRevenue) * 100;
          // Never collapse to zero width visually — keeps the funnel
          // shape readable even for empty stages.
          const renderedPct = Math.max(8, pct);
          // Conversion vs previous stage by revenue.
          const prev = i > 0 ? ordered[i - 1]! : null;
          const conversionPct =
            prev && prev.totalAmountMinor > 0
              ? Math.round((row.totalAmountMinor / prev.totalAmountMinor) * 100)
              : null;

          return (
            <li key={stage} className="flex items-center gap-3">
              {/* Stage label on the left for instant scan */}
              <span className="w-28 flex-shrink-0 text-[11.5px] font-semibold uppercase tracking-wide text-slate-600 dark:text-[#A1A1AA]">
                {STAGE_LABELS[stage]}
              </span>

              {/* Funnel band — SVG so dark + light fills share one tree */}
              <div className="relative h-10 flex-1 min-w-0">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 h-full w-full"
                  aria-hidden
                >
                  <title>
                    {STAGE_LABELS[stage]}: {row.count} deal
                    {row.count === 1 ? '' : 's'}, {formatCurrency(row.totalAmountMinor)}
                  </title>
                  <rect
                    x={`${(100 - renderedPct) / 2}`}
                    y="6"
                    width={`${renderedPct}`}
                    height="88"
                    rx="3"
                    ry="3"
                    fill={tint.fill}
                    className="dark:hidden"
                  />
                  <rect
                    x={`${(100 - renderedPct) / 2}`}
                    y="6"
                    width={`${renderedPct}`}
                    height="88"
                    rx="3"
                    ry="3"
                    fill={tint.darkFill}
                    className="hidden dark:block"
                  />
                </svg>
                <div className="relative flex h-full items-center justify-center px-2">
                  <span
                    className={cn(
                      'font-mono text-[12px] font-semibold tabular-nums',
                      tint.text,
                    )}
                  >
                    {formatCurrency(row.totalAmountMinor)}
                  </span>
                </div>
              </div>

              {/* Right meta column: count + conversion */}
              <div className="w-32 flex-shrink-0 text-right">
                <div className="font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-[#FAFAFA]">
                  {row.count} {row.count === 1 ? 'deal' : 'deals'}
                </div>
                {conversionPct !== null ? (
                  <div
                    className={cn(
                      'text-[10px]',
                      conversionPct >= 60
                        ? 'text-emerald-600 dark:text-emerald-300'
                        : conversionPct >= 30
                          ? 'text-slate-500 dark:text-[#A1A1AA]'
                          : 'text-rose-600 dark:text-rose-300',
                    )}
                  >
                    {conversionPct}% vs {STAGE_LABELS[ordered[i - 1]!.stage as FunnelStage]}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
