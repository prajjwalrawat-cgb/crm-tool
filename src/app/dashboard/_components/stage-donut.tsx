import { PieChart } from 'lucide-react';

import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

/**
 * Stage Donut — counts-only companion to the revenue funnel. Renders
 * deal-count distribution as a server-rendered SVG donut. No client
 * JS, no chart library — the geometry is computed in TS and the dark
 * variant swaps fills via the `dark:` class on each <path>.
 *
 * Counts live here. The funnel is for revenue weight; this is for
 * "where are the deals piling up". Two distinct questions, two
 * distinct charts — that's the whole reason the user asked for the
 * split.
 */

type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';

const STAGE_ORDER: readonly Stage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
];

const STAGE_LABELS: Record<Stage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

const STAGE_FILL: Record<
  Stage,
  { light: string; dark: string; dot: string }
> = {
  lead: { light: '#c7d2fe', dark: 'rgba(99,102,241,0.35)', dot: 'bg-indigo-200' },
  qualified: { light: '#a5b4fc', dark: 'rgba(99,102,241,0.55)', dot: 'bg-indigo-300' },
  proposal: { light: '#a78bfa', dark: 'rgba(139,92,246,0.65)', dot: 'bg-violet-400' },
  negotiation: { light: '#fcd34d', dark: 'rgba(245,158,11,0.7)', dot: 'bg-amber-400' },
  won: { light: '#6ee7b7', dark: 'rgba(16,185,129,0.8)', dot: 'bg-emerald-400' },
  lost: { light: '#fca5a5', dark: 'rgba(244,63,94,0.55)', dot: 'bg-rose-400' },
};

export function StageDonut({
  rows,
  className,
  title = 'Deal distribution',
  subtitle = 'How many deals sit in each stage',
}: {
  rows: PipelineByStageRow[];
  className?: string;
  title?: string;
  subtitle?: string;
}) {
  const byStage = new Map<Stage, number>();
  let total = 0;
  for (const r of rows) {
    if ((STAGE_ORDER as readonly string[]).includes(r.stage)) {
      byStage.set(r.stage as Stage, r.count);
      total += r.count;
    }
  }

  const segments = STAGE_ORDER.map((stage) => ({
    stage,
    count: byStage.get(stage) ?? 0,
  }));

  // Donut geometry — viewBox 100x100, ring 40-50 radius. We draw each
  // segment as a SVG path with an arc per slice. Cumulative angle is
  // tracked so the next segment starts where the previous ends.
  const cx = 50;
  const cy = 50;
  const rOuter = 44;
  const rInner = 28;

  let cumulative = 0;
  const paths = segments.map((seg) => {
    if (seg.count === 0 || total === 0) return null;
    const fraction = seg.count / total;
    const startAngle = cumulative * Math.PI * 2 - Math.PI / 2;
    cumulative += fraction;
    const endAngle = cumulative * Math.PI * 2 - Math.PI / 2;

    // Skip the rare "everything in one stage" edge case so we don't
    // try to draw a 360° arc as a single Bézier (that renders empty).
    const isFullCircle = fraction >= 0.999;
    const arcPath = isFullCircle
      ? buildFullDonutPath(cx, cy, rOuter, rInner)
      : buildDonutArcPath(cx, cy, rOuter, rInner, startAngle, endAngle);

    return {
      stage: seg.stage,
      count: seg.count,
      pct: Math.round(fraction * 100),
      d: arcPath,
    };
  });

  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <PieChart className="h-3 w-3" aria-hidden />
            Counts
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {title}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {subtitle}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Total deals
          </div>
          <div className="font-mono text-xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
            {total}
          </div>
        </div>
      </header>

      {total === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No deals yet — create one to see the distribution.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative h-40 w-40 flex-shrink-0">
            <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
              {/* Background ring */}
              <path
                d={buildFullDonutPath(cx, cy, rOuter, rInner)}
                fill="rgb(241 245 249)"
                fillRule="evenodd"
                className="dark:hidden"
              />
              <path
                d={buildFullDonutPath(cx, cy, rOuter, rInner)}
                fill="rgba(255,255,255,0.04)"
                fillRule="evenodd"
                className="hidden dark:block"
              />
              {paths.map((p) =>
                p ? (
                  <g key={p.stage}>
                    <path
                      d={p.d}
                      fill={STAGE_FILL[p.stage].light}
                      fillRule="evenodd"
                      className="dark:hidden"
                    >
                      <title>
                        {`${STAGE_LABELS[p.stage]}: ${p.count} ${p.count === 1 ? 'deal' : 'deals'} (${p.pct}%)`}
                      </title>
                    </path>
                    <path
                      d={p.d}
                      fill={STAGE_FILL[p.stage].dark}
                      fillRule="evenodd"
                      className="hidden dark:block"
                    >
                      <title>
                        {`${STAGE_LABELS[p.stage]}: ${p.count} ${p.count === 1 ? 'deal' : 'deals'} (${p.pct}%)`}
                      </title>
                    </path>
                  </g>
                ) : null,
              )}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                {total}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                deals
              </span>
            </div>
          </div>

          <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
            {paths.map((p) =>
              p ? (
                <li
                  key={p.stage}
                  className="flex items-center justify-between gap-2 text-[12px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 flex-shrink-0 rounded-full',
                        STAGE_FILL[p.stage].dot,
                      )}
                      aria-hidden
                    />
                    <span className="truncate text-slate-700 dark:text-[#FAFAFA]">
                      {STAGE_LABELS[p.stage]}
                    </span>
                  </span>
                  <span className="flex flex-shrink-0 items-baseline gap-2 font-mono tabular-nums">
                    <span className="font-semibold text-slate-900 dark:text-[#FAFAFA]">
                      {p.count}
                    </span>
                    <span className="text-[10px] text-slate-500 dark:text-[#A1A1AA]">
                      {p.pct}%
                    </span>
                  </span>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  };
}

function buildDonutArcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, rOuter, startAngle);
  const outerEnd = polarToCartesian(cx, cy, rOuter, endAngle);
  const innerEnd = polarToCartesian(cx, cy, rInner, endAngle);
  const innerStart = polarToCartesian(cx, cy, rInner, startAngle);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

function buildFullDonutPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
): string {
  // Two opposing half-arcs, even-odd fill rule via concentric circles.
  return [
    `M ${cx - rOuter} ${cy}`,
    `A ${rOuter} ${rOuter} 0 1 0 ${cx + rOuter} ${cy}`,
    `A ${rOuter} ${rOuter} 0 1 0 ${cx - rOuter} ${cy}`,
    'Z',
    `M ${cx - rInner} ${cy}`,
    `A ${rInner} ${rInner} 0 1 1 ${cx + rInner} ${cy}`,
    `A ${rInner} ${rInner} 0 1 1 ${cx - rInner} ${cy}`,
    'Z',
  ].join(' ');
}
