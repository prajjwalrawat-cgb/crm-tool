import { AlertTriangle, Sparkles, TrendingUp } from 'lucide-react';

import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

/**
 * Premium revenue funnel — the dashboard's hero. Three horizontal
 * regions stacked top-to-bottom:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  KPI strip: Pipeline · Weighted · Expected close · …  │
 *   ├────────────────────────────┬─────────────────────────┤
 *   │                            │  Right panel: per-stage  │
 *   │  Tapered SVG funnel        │   count · avg deal size  │
 *   │  (trapezoidal bands)       │   conversion · close %   │
 *   │                            │                          │
 *   ├────────────────────────────┴─────────────────────────┤
 *   │  Stage-to-stage leakage strip with warnings           │
 *   └──────────────────────────────────────────────────────┘
 *
 * Geometry: width of each stage band is proportional to that stage's
 * total revenue. Bands taper into each other via polygon trapezoids
 * (top-left/top-right of stage N+1 align with bottom-left/bottom-right
 * of stage N), giving the actual funnel silhouette.
 *
 * All SVG. No client JS. Hover via CSS transitions. Gradients via
 * <linearGradient> defs. Dark mode swaps fills via class-conditional
 * <stop> colors — same DOM, two color trees.
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

/**
 * Heuristic close-probability weights. Future scope: per-tenant overrides.
 */
const STAGE_PROBABILITY: Record<FunnelStage, number> = {
  lead: 0.1,
  qualified: 0.25,
  proposal: 0.5,
  negotiation: 0.75,
  won: 1.0,
};

/** Light / dark gradient stops keyed to the stage tint family. */
const STAGE_GRADIENT: Record<
  FunnelStage,
  {
    lightFrom: string;
    lightVia: string;
    lightTo: string;
    darkFrom: string;
    darkVia: string;
    darkTo: string;
    accent: string;
  }
> = {
  lead: {
    lightFrom: '#eef2ff',
    lightVia: '#e0e7ff',
    lightTo: '#c7d2fe',
    darkFrom: 'rgba(99,102,241,0.16)',
    darkVia: 'rgba(99,102,241,0.26)',
    darkTo: 'rgba(99,102,241,0.36)',
    accent: 'text-indigo-800 dark:text-indigo-100',
  },
  qualified: {
    lightFrom: '#c7d2fe',
    lightVia: '#a5b4fc',
    lightTo: '#818cf8',
    darkFrom: 'rgba(99,102,241,0.32)',
    darkVia: 'rgba(99,102,241,0.48)',
    darkTo: 'rgba(99,102,241,0.6)',
    accent: 'text-indigo-900 dark:text-indigo-50',
  },
  proposal: {
    lightFrom: '#c4b5fd',
    lightVia: '#a78bfa',
    lightTo: '#8b5cf6',
    darkFrom: 'rgba(139,92,246,0.4)',
    darkVia: 'rgba(139,92,246,0.55)',
    darkTo: 'rgba(139,92,246,0.7)',
    accent: 'text-violet-900 dark:text-violet-50',
  },
  negotiation: {
    lightFrom: '#fde68a',
    lightVia: '#fcd34d',
    lightTo: '#fbbf24',
    darkFrom: 'rgba(245,158,11,0.45)',
    darkVia: 'rgba(245,158,11,0.6)',
    darkTo: 'rgba(245,158,11,0.78)',
    accent: 'text-amber-900 dark:text-amber-100',
  },
  won: {
    lightFrom: '#86efac',
    lightVia: '#34d399',
    lightTo: '#10b981',
    darkFrom: 'rgba(16,185,129,0.55)',
    darkVia: 'rgba(16,185,129,0.75)',
    darkTo: 'rgba(16,185,129,0.95)',
    accent: 'text-emerald-900 dark:text-emerald-50',
  },
};

export function RevenueFunnel({
  rows,
  formatCurrency,
  className,
}: {
  rows: PipelineByStageRow[];
  formatCurrency: (amountMinor: number) => string;
  className?: string;
}) {
  // Build a stable ordered set of forward stages.
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

  // ----- aggregate metrics for KPI strip -----
  const totalRevenue = ordered.reduce((s, r) => s + r.totalAmountMinor, 0);
  const wonRow = ordered.find((r) => r.stage === 'won');
  const wonRevenue = wonRow?.totalAmountMinor ?? 0;
  const wonCount = wonRow?.count ?? 0;
  const totalDealsForward = ordered.reduce((s, r) => s + r.count, 0);
  // Weighted = forward (non-won) revenue × stage probability
  const weightedPipeline = ordered
    .filter((r) => r.stage !== 'won')
    .reduce(
      (s, r) => s + r.totalAmountMinor * STAGE_PROBABILITY[r.stage as FunnelStage],
      0,
    );
  const expectedClose = weightedPipeline + wonRevenue;
  // Overall conversion = won / (won + total in forward stages). Sane denom.
  const overallConvDenom = totalDealsForward;
  const overallConvPct =
    overallConvDenom > 0 ? Math.round((wonCount / overallConvDenom) * 100) : 0;
  const avgDealSize =
    totalDealsForward > 0 ? Math.round(totalRevenue / totalDealsForward) : 0;

  // ----- geometry -----
  const maxRevenue = Math.max(...ordered.map((r) => r.totalAmountMinor), 1);
  // Each band gets a normalized width 0..1 of the canvas; we keep an
  // 8% minimum so empty stages still show a thin silhouette.
  const bandWidth = (revenue: number) =>
    Math.max(0.08, revenue / maxRevenue);

  // 5 stages → 5 bands. Each band has its own top/bottom edge; the
  // bottom of band i equals the top of band i+1. After the last band
  // the silhouette converges to the "won" width (no taper to zero).
  const widths = ordered.map((r) => bandWidth(r.totalAmountMinor));

  // SVG canvas: 100 wide × 100 tall. Each band takes 100/5 = 20 units.
  const VB_W = 100;
  const VB_H = 100;
  const BAND_H = VB_H / ordered.length;

  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-white to-slate-50/60 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:from-[#0A0A0A] dark:via-[#0A0A0A] dark:to-[#000000]',
        className,
      )}
    >
      {/* ---------- TOP: KPI strip ---------- */}
      <header className="border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <TrendingUp className="h-3 w-3" aria-hidden />
              Revenue funnel
            </div>
            <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Where the money is moving
            </h2>
            <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              Width is revenue, not deal count. Weighted figure uses
              stage close-probability.
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi label="Pipeline" value={formatCurrency(totalRevenue)} accent="slate" />
          <Kpi
            label="Weighted"
            value={formatCurrency(weightedPipeline)}
            accent="indigo"
            sub="prob-adjusted"
          />
          <Kpi
            label="Expected close"
            value={formatCurrency(expectedClose)}
            accent="emerald"
            sub={wonRevenue > 0 ? `${formatCurrency(wonRevenue)} won` : 'won + weighted'}
          />
          <Kpi
            label="Conversion"
            value={`${overallConvPct}%`}
            accent="violet"
            sub={`${wonCount} won / ${totalDealsForward} total`}
          />
          <Kpi
            label="Avg deal size"
            value={formatCurrency(avgDealSize)}
            accent="amber"
          />
        </div>
      </header>

      {/* ---------- CENTER: funnel SVG + right panel ---------- */}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* --- SVG --- */}
        <div className="relative px-5 py-5">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="h-72 w-full sm:h-80"
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              {/* Subtle drop shadow under each band; light + dark
                  variants so the dark theme doesn't get a glow halo. */}
              <filter id="fnlt-shadow-light" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="0.6" />
                <feOffset dy="0.6" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.18" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="fnlt-shadow-dark" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="0.8" />
                <feOffset dy="0.4" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.4" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              {ordered.map((row) => {
                const stage = row.stage as FunnelStage;
                const grad = STAGE_GRADIENT[stage];
                return (
                  <g key={`grad-${stage}`}>
                    <linearGradient
                      id={`fnlt-light-${stage}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={grad.lightFrom} />
                      <stop offset="55%" stopColor={grad.lightVia} />
                      <stop offset="100%" stopColor={grad.lightTo} />
                    </linearGradient>
                    <linearGradient
                      id={`fnlt-dark-${stage}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={grad.darkFrom} />
                      <stop offset="55%" stopColor={grad.darkVia} />
                      <stop offset="100%" stopColor={grad.darkTo} />
                    </linearGradient>
                  </g>
                );
              })}
            </defs>

            {ordered.map((row, i) => {
              const stage = row.stage as FunnelStage;
              const top = i * BAND_H;
              const bottom = (i + 1) * BAND_H;
              const wTop = widths[i]! * VB_W;
              // Last stage's bottom doesn't taper — keep parallel to top.
              const wBot = (widths[i + 1] ?? widths[i]!) * VB_W;
              const halfTop = wTop / 2;
              const halfBot = wBot / 2;
              const cx = VB_W / 2;
              // Trapezoid corners, clockwise from top-left.
              const points = [
                `${cx - halfTop},${top}`,
                `${cx + halfTop},${top}`,
                `${cx + halfBot},${bottom}`,
                `${cx - halfBot},${bottom}`,
              ].join(' ');

              return (
                <g key={stage}>
                  <polygon
                    points={points}
                    fill={`url(#fnlt-light-${stage})`}
                    filter="url(#fnlt-shadow-light)"
                    className="transition-opacity duration-200 hover:opacity-95 dark:hidden"
                  >
                    <title>
                      {`${STAGE_LABELS[stage]}: ${row.count} ${row.count === 1 ? 'deal' : 'deals'} · ${formatCurrency(row.totalAmountMinor)}`}
                    </title>
                  </polygon>
                  <polygon
                    points={points}
                    fill={`url(#fnlt-dark-${stage})`}
                    filter="url(#fnlt-shadow-dark)"
                    className="hidden transition-opacity duration-200 hover:opacity-95 dark:block"
                  >
                    <title>
                      {`${STAGE_LABELS[stage]}: ${row.count} ${row.count === 1 ? 'deal' : 'deals'} · ${formatCurrency(row.totalAmountMinor)}`}
                    </title>
                  </polygon>
                  {/* Thin hairline divider between bands for crisper
                      stage transitions. */}
                  {i < ordered.length - 1 ? (
                    <line
                      x1={cx - halfBot}
                      x2={cx + halfBot}
                      y1={bottom}
                      y2={bottom}
                      stroke="rgba(15,23,42,0.06)"
                      strokeWidth="0.3"
                      className="dark:hidden"
                    />
                  ) : null}
                  {i < ordered.length - 1 ? (
                    <line
                      x1={cx - halfBot}
                      x2={cx + halfBot}
                      y1={bottom}
                      y2={bottom}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="0.3"
                      className="hidden dark:block"
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>

          {/* Stage labels overlay — absolutely positioned per band so
              they sit centered inside the trapezoid regardless of SVG
              scaling. Per-stage conversion % from the previous stage
              renders right next to the revenue figure. */}
          <div className="pointer-events-none absolute inset-x-5 top-5 bottom-5">
            <ul className="relative grid h-full" style={{ gridTemplateRows: `repeat(${ordered.length}, minmax(0, 1fr))` }}>
              {ordered.map((row, i) => {
                const stage = row.stage as FunnelStage;
                const prev = i > 0 ? ordered[i - 1]! : null;
                const conversionPct =
                  prev && prev.totalAmountMinor > 0
                    ? Math.round((row.totalAmountMinor / prev.totalAmountMinor) * 100)
                    : null;
                return (
                  <li
                    key={stage}
                    className="relative flex items-center justify-center fnlt-band-fade"
                    style={{
                      animationDelay: `${i * 70}ms`,
                    }}
                  >
                    <div className="flex flex-col items-center text-center">
                      <span
                        className={cn(
                          'text-[10.5px] font-semibold uppercase tracking-[0.12em]',
                          STAGE_GRADIENT[stage].accent,
                        )}
                      >
                        {STAGE_LABELS[stage]}
                      </span>
                      <div className="mt-0.5 flex items-baseline gap-1.5">
                        <span
                          className={cn(
                            'font-mono text-[12px] font-semibold tabular-nums',
                            STAGE_GRADIENT[stage].accent,
                          )}
                        >
                          {formatCurrency(row.totalAmountMinor)}
                        </span>
                        {conversionPct !== null ? (
                          <span
                            className={cn(
                              'rounded px-1 py-px font-mono text-[9.5px] font-semibold tabular-nums backdrop-blur-sm',
                              conversionPct >= 60
                                ? 'bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100'
                                : conversionPct >= 30
                                  ? 'bg-white/70 text-slate-700 dark:bg-white/10 dark:text-slate-200'
                                  : 'bg-rose-100/80 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100',
                            )}
                          >
                            {conversionPct}%
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Inline keyframes — CSS-only, no client JS. Server-rendered
              <style>; safe and scoped via the unique class name. */}
          <style>{`
            @keyframes fnlt-fade-in {
              from { opacity: 0; transform: translateY(2px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            .fnlt-band-fade {
              animation: fnlt-fade-in 360ms ease-out both;
            }
            @media (prefers-reduced-motion: reduce) {
              .fnlt-band-fade { animation: none; }
            }
          `}</style>
        </div>

        {/* --- Right panel: per-stage metrics --- */}
        <aside className="border-t border-slate-200 px-5 py-5 lg:border-l lg:border-t-0 dark:border-[#1F1F1F]">
          <h3 className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#A1A1AA]">
            Per stage
          </h3>
          <ul className="space-y-2.5">
            {ordered.map((row) => {
              const stage = row.stage as FunnelStage;
              const grad = STAGE_GRADIENT[stage];
              const prob = Math.round(STAGE_PROBABILITY[stage] * 100);
              const avg = row.count > 0 ? Math.round(row.totalAmountMinor / row.count) : 0;
              return (
                <li
                  key={stage}
                  className="rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 dark:border-[#1F1F1F]/70 dark:bg-[#111111]/60"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        'text-[11px] font-semibold uppercase tracking-wide',
                        grad.accent,
                      )}
                    >
                      {STAGE_LABELS[stage]}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-slate-400 dark:text-[#71717A]">
                      {prob}% close prob
                    </span>
                  </div>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                    <dt className="text-slate-500 dark:text-[#A1A1AA]">Deals</dt>
                    <dd className="text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                      {row.count}
                    </dd>
                    <dt className="text-slate-500 dark:text-[#A1A1AA]">Avg size</dt>
                    <dd className="text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                      {row.count > 0 ? formatCurrency(avg) : '—'}
                    </dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      {/* ---------- BOTTOM: leakage / stage-to-stage strip ---------- */}
      <LeakageStrip ordered={ordered} />
    </section>
  );
}

/* ============================================================ */
/* KPI tile                                                      */
/* ============================================================ */

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: 'slate' | 'indigo' | 'emerald' | 'violet' | 'amber';
}) {
  const valueClass = {
    slate: 'text-slate-900 dark:text-[#FAFAFA]',
    indigo: 'text-indigo-700 dark:text-indigo-300',
    emerald: 'text-emerald-700 dark:text-emerald-300',
    violet: 'text-violet-700 dark:text-violet-300',
    amber: 'text-amber-700 dark:text-amber-300',
  }[accent];
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 truncate font-mono text-[18px] font-semibold leading-tight tabular-nums',
          valueClass,
        )}
        title={value}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 truncate text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================ */
/* Leakage / conversion strip                                    */
/* ============================================================ */

function LeakageStrip({
  ordered,
}: {
  ordered: Array<{ stage: string; count: number; totalAmountMinor: number }>;
}) {
  // For each consecutive pair, compute revenue retention. <30% = leak,
  // 30-60% = warn, >60% = healthy. Empty-prev stages skip rendering
  // because the ratio is undefined.
  const pairs: Array<{
    fromLabel: string;
    toLabel: string;
    pct: number | null;
    tone: 'good' | 'warn' | 'bad' | 'neutral';
  }> = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const prevAmt = prev.totalAmountMinor;
    if (prevAmt === 0 && cur.totalAmountMinor === 0) {
      pairs.push({
        fromLabel: humanLabel(prev.stage),
        toLabel: humanLabel(cur.stage),
        pct: null,
        tone: 'neutral',
      });
      continue;
    }
    const pct =
      prevAmt > 0 ? Math.round((cur.totalAmountMinor / prevAmt) * 100) : null;
    const tone: 'good' | 'warn' | 'bad' | 'neutral' =
      pct === null ? 'neutral' : pct >= 60 ? 'good' : pct >= 30 ? 'warn' : 'bad';
    pairs.push({
      fromLabel: humanLabel(prev.stage),
      toLabel: humanLabel(cur.stage),
      pct,
      tone,
    });
  }

  return (
    <div className="border-t border-slate-200 px-5 py-3 dark:border-[#1F1F1F]">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-slate-400 dark:text-[#71717A]" aria-hidden />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#A1A1AA]">
          Stage-to-stage conversion
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pairs.map((p, i) => {
          const toneClass = {
            good: 'border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
            warn: 'border-amber-200 bg-amber-50/70 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
            bad: 'border-rose-200 bg-rose-50/70 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
            neutral: 'border-slate-200 bg-slate-50/70 text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]',
          }[p.tone];
          return (
            <div
              key={i}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium',
                toneClass,
              )}
            >
              <span className="text-[10px] opacity-70">{p.fromLabel}</span>
              <span aria-hidden>→</span>
              <span className="text-[10px] opacity-70">{p.toLabel}</span>
              <span className="font-mono font-semibold tabular-nums">
                {p.pct === null ? '—' : `${p.pct}%`}
              </span>
              {p.tone === 'bad' ? (
                <AlertTriangle className="h-3 w-3" aria-hidden />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function humanLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}
