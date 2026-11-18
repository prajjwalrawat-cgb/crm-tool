/**
 * Metrics registry — the ONE place a manager-report metric is defined.
 *
 * Client-safe: labels, units, direction and the pure derivation from
 * counters. The SQL that produces counters lives in
 * `src/lib/reports/manager/facts.ts`; every chart, tile, export, digest and
 * the AI narrative read metric values through `metricValue()` or the
 * services in `src/lib/reports/manager/services.ts`, which call into here.
 * Route handlers and React never compute a metric themselves.
 *
 * Two kinds of metric:
 *   - `rollup`: derived from additive daily counters (report_daily_rollup,
 *     plus a live read of today). Cheap over any range.
 *   - `live`: needs row-level data (medians, cohorts, current snapshot) and
 *     is computed by its own service query over a bounded window.
 *
 * FUNNEL / COHORT DEFINITION (qualified_rate, stage_conversion, funnel page):
 *   cohort = deals created in the range (tenant timezone days), in scope.
 *   A cohort lead "reached" a stage if deal_stage_history shows it entered
 *   that stage OR any later funnel stage (lead → qualified → proposal →
 *   negotiation → won). Each lead counts at most once per stage, however
 *   often it re-enters; regressions do not un-reach a stage; hold and lost
 *   are not funnel stages. See `computeFunnel` in manager/math.ts.
 */

import { pct, ratio, round1, round2, type FactCounters } from './manager/math';

export type MetricUnit = 'count' | 'decimal' | 'percent' | 'currency' | 'seconds' | 'minutes' | 'days' | 'ratio';
export type MetricGroupBy = 'day' | 'owner' | 'source';

export type MetricContext = {
  /** Reps in scope (for per-rep averages). */
  reps: number;
  /** Calendar days in the range. */
  days: number;
};

type Base = {
  key: string;
  label: string;
  unit: MetricUnit;
  higherIsBetter: boolean;
  allowedGroupBy: readonly MetricGroupBy[];
  /** Plain-language definition shown in tooltips and docs/reports.md. */
  description: string;
};

export type RollupMetric = Base & {
  source: 'rollup';
  compute: (c: FactCounters, ctx: MetricContext) => number | null;
};

export type LiveMetric = Base & { source: 'live' };

export type MetricDefinition = RollupMetric | LiveMetric;

const ALL: readonly MetricGroupBy[] = ['day', 'owner', 'source'];
const DAY_OWNER: readonly MetricGroupBy[] = ['day', 'owner'];

const DEFS = [
  {
    key: 'lead_volume',
    label: 'Leads',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Deals created in the period (every captured or hand-entered lead).',
    compute: (c) => c.leadsCreated,
  },
  {
    key: 'qualified',
    label: 'Qualified',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Deals that moved into Qualified during the period (counted once per deal per day).',
    compute: (c) => c.qualified,
  },
  {
    key: 'quotes_sent',
    label: 'Proposals',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Deals that moved into Proposal during the period.',
    compute: (c) => c.quotesSent,
  },
  {
    key: 'won_count',
    label: 'Deals won',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Deals closed as Won in the period.',
    compute: (c) => c.wonCount,
  },
  {
    key: 'won_value',
    label: 'Won value',
    unit: 'currency',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Total value of deals closed as Won in the period.',
    compute: (c) => round2(c.wonValue),
  },
  {
    key: 'win_rate',
    label: 'Win rate',
    unit: 'percent',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Won ÷ (won + lost), for deals closed in the period.',
    compute: (c) => pct(c.wonCount, c.wonCount + c.lostCount),
  },
  {
    key: 'avg_deal_value',
    label: 'Average deal value',
    unit: 'currency',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Won value ÷ deals won, in the period.',
    compute: (c) => {
      const r = ratio(c.wonValue, c.wonCount);
      return r === null ? null : round2(r);
    },
  },
  {
    key: 'calls_made',
    label: 'Calls made',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Outbound calls started in the period.',
    compute: (c) => c.callsMade,
  },
  {
    key: 'contact_rate',
    label: 'Contact rate',
    unit: 'percent',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Outbound calls that were answered ÷ outbound calls made.',
    compute: (c) => pct(c.callsConnected, c.callsMade),
  },
  {
    key: 'talk_time',
    label: 'Talk time',
    unit: 'minutes',
    higherIsBetter: true,
    allowedGroupBy: ALL,
    source: 'rollup',
    description: 'Minutes spent talking on connected calls.',
    compute: (c) => round1(c.talkTimeSec / 60),
  },
  {
    key: 'emails_sent',
    label: 'Emails sent',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: DAY_OWNER,
    source: 'rollup',
    description: 'Emails sent from the CRM (sent or delivered).',
    compute: (c) => c.emailsSent,
  },
  {
    key: 'meetings_held',
    label: 'Meetings',
    unit: 'count',
    higherIsBetter: true,
    allowedGroupBy: DAY_OWNER,
    source: 'rollup',
    description: 'Meetings logged on deals.',
    compute: (c) => c.meetingsHeld,
  },
  {
    key: 'activities_per_rep_per_day',
    label: 'Activities / rep / day',
    unit: 'decimal',
    higherIsBetter: true,
    allowedGroupBy: DAY_OWNER,
    source: 'rollup',
    description: 'Every logged activity (calls, emails, notes, stage moves …) ÷ reps ÷ days.',
    compute: (c, ctx) => (ctx.reps > 0 && ctx.days > 0 ? round1(c.activities / ctx.reps / ctx.days) : null),
  },
  {
    key: 'qualified_rate',
    label: 'Qualified rate',
    unit: 'percent',
    higherIsBetter: true,
    allowedGroupBy: ['owner', 'source'],
    source: 'live',
    description: 'Of the leads created in the period, the share that reached Qualified or beyond (cohort).',
  },
  {
    key: 'stage_conversion',
    label: 'Stage conversion',
    unit: 'percent',
    higherIsBetter: true,
    allowedGroupBy: ['owner', 'source'],
    source: 'live',
    description: 'Of the leads created in the period that reached stage A, the share that reached stage B within N days.',
  },
  {
    key: 'sales_cycle_days',
    label: 'Sales cycle',
    unit: 'days',
    higherIsBetter: false,
    allowedGroupBy: ['owner', 'source'],
    source: 'live',
    description: 'Days from creation to Won, for deals won in the period (median, and p75).',
  },
  {
    key: 'pipeline_value',
    label: 'Open pipeline',
    unit: 'currency',
    higherIsBetter: true,
    allowedGroupBy: ['owner'],
    source: 'live',
    description: 'Value of open deals right now (any stage except Won/Lost), and the same weighted by stage probability.',
  },
  {
    key: 'forecast_this_month',
    label: 'Forecast this month',
    unit: 'currency',
    higherIsBetter: true,
    allowedGroupBy: ['owner'],
    source: 'live',
    description: 'Weighted value of open deals expected to close this calendar month.',
  },
  {
    key: 'first_response_time',
    label: 'First response',
    unit: 'minutes',
    higherIsBetter: false,
    allowedGroupBy: ['owner', 'source'],
    source: 'live',
    description: 'Minutes from a lead being assigned to its owner’s first call, email or note (median, and p90).',
  },
  {
    key: 'sla_compliance_pct',
    label: 'SLA met',
    unit: 'percent',
    higherIsBetter: true,
    allowedGroupBy: ['owner', 'source'],
    source: 'live',
    description: 'Of assignments whose response deadline has passed (or that were answered), the share answered before the deadline.',
  },
  {
    key: 'stale_leads',
    label: 'Stale leads',
    unit: 'count',
    higherIsBetter: false,
    allowedGroupBy: ['owner'],
    source: 'live',
    description: 'Open deals with no activity for more than X days (default 7).',
  },
  {
    key: 'source_roi',
    label: 'Source ROI',
    unit: 'ratio',
    higherIsBetter: true,
    allowedGroupBy: ['source'],
    source: 'live',
    description: 'Won value from a source ÷ what was spent on it in the same months.',
  },
  {
    key: 'cost_per_lead',
    label: 'Cost per lead',
    unit: 'currency',
    higherIsBetter: false,
    allowedGroupBy: ['source'],
    source: 'live',
    description: 'Spend ÷ leads from that source.',
  },
  {
    key: 'cost_per_won',
    label: 'Cost per won deal',
    unit: 'currency',
    higherIsBetter: false,
    allowedGroupBy: ['source'],
    source: 'live',
    description: 'Spend ÷ deals won from that source.',
  },
] as const satisfies readonly MetricDefinition[];

export type MetricKey = (typeof DEFS)[number]['key'];

export const METRICS: Record<MetricKey, MetricDefinition> = Object.fromEntries(
  DEFS.map((d) => [d.key, d as MetricDefinition]),
) as Record<MetricKey, MetricDefinition>;

export const METRIC_KEYS = DEFS.map((d) => d.key) as MetricKey[];

export function isMetricKey(k: string): k is MetricKey {
  return k in METRICS;
}

/** Value of a rollup metric from counters; null for live metrics or no data. */
export function metricValue(key: MetricKey, c: FactCounters, ctx: MetricContext): number | null {
  const def = METRICS[key];
  return def.source === 'rollup' ? def.compute(c, ctx) : null;
}

/* ------------------------------------------------------- source ROI math */

export function sourceRoi(wonValue: number, spend: number): number | null {
  const r = ratio(wonValue, spend);
  return r === null ? null : round2(r);
}

export function costPer(spend: number, n: number): number | null {
  const r = ratio(spend, n);
  return r === null ? null : round2(r);
}

/** Display formatting by unit — shared by tiles, tables, digests. */
export function formatMetric(
  unit: MetricUnit,
  value: number | null,
  fmtCurrency: (major: number) => string = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${round1(value)}%`;
    case 'currency':
      return fmtCurrency(value);
    case 'seconds':
      return `${Math.round(value)}s`;
    case 'minutes':
      return value >= 120 ? `${round1(value / 60)} h` : `${round1(value)} min`;
    case 'days':
      return `${round1(value)} d`;
    case 'ratio':
      return `${round2(value)}×`.replace('.00×', '×');
    case 'decimal':
      return String(round1(value));
    case 'count':
    default:
      return Math.round(value).toLocaleString('en-IN');
  }
}
