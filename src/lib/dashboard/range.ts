/**
 * The dashboard's single shared time window.
 *
 * ONE query param (`range`, plus `from`/`to` when custom) drives the
 * KPI strip, the revenue trend chart, pipeline-by-stage and the deal
 * highlights. Four widgets holding four independent ranges was the
 * thing that made the old dashboard impossible to reason about, so
 * every consumer resolves through here.
 *
 * Deliberately NOT `server-only`: the range picker is a client
 * component and needs the labels + serializer. No DB, no env access.
 *
 * Presets reuse `DateRangePreset` from the reports layer so a URL
 * built on the dashboard means the same thing on /dashboard/reports.
 */

import { resolveDateRange } from '@/lib/reports/filters';
import type { DateRangePreset } from '@/lib/reports/types';

/** Presets offered by the dashboard picker, in display order. */
export const DASHBOARD_RANGE_PRESETS = [
  'last_7d',
  'last_30d',
  'last_90d',
  'this_quarter',
  'this_year',
] as const satisfies readonly DateRangePreset[];

export type DashboardRangePreset = (typeof DASHBOARD_RANGE_PRESETS)[number];

export const DASHBOARD_RANGE_SHORT_LABELS: Record<DashboardRangePreset, string> =
  {
    last_7d: '7d',
    last_30d: '30d',
    last_90d: '90d',
    this_quarter: 'QTD',
    this_year: 'YTD',
  };

export const DEFAULT_DASHBOARD_RANGE: DashboardRangePreset = 'last_90d';

export type DashboardRange = {
  /** `custom` when explicit `from`/`to` params were supplied. */
  preset: DashboardRangePreset | 'custom';
  /** Inclusive start (UTC). */
  from: Date;
  /** Exclusive end (UTC). */
  to: Date;
  /** Whole days covered — what `getRevenueTrend` wants. */
  days: number;
  /** Human label for headers ("Last 90 days", "12 Apr – 3 Jul 2026"). */
  label: string;
  /**
   * The immediately preceding window of equal length. Every KPI delta
   * compares against this, so "vs prior period" always means the same
   * thing across tiles.
   */
  prior: { from: Date; to: Date };
};

const MS_PER_DAY = 86_400_000;

function isPreset(v: string): v is DashboardRangePreset {
  return (DASHBOARD_RANGE_PRESETS as readonly string[]).includes(v);
}

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** `YYYY-MM-DD` → UTC midnight, or null when malformed. */
function parseIsoDay(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve `?range=` (+ `?from=&?to=` for custom) into the window every
 * dashboard widget shares. Unknown/garbage values fall back to the
 * default preset rather than throwing — a hand-edited URL should
 * degrade, not 500.
 *
 * Custom ranges are clamped to 730 days so a typo (`from=1970-01-01`)
 * can't turn the trend query into a full-table scan.
 */
export function resolveDashboardRange(
  params: Partial<Record<string, string | string[] | undefined>>,
): DashboardRange {
  const rawRange = first(params.range);
  const customFrom = parseIsoDay(first(params.from));
  const customTo = parseIsoDay(first(params.to));

  if (rawRange === 'custom' && customFrom && customTo && customTo >= customFrom) {
    // `to` arrives inclusive from the date input; make it exclusive so
    // it matches the half-open convention used everywhere else.
    const toExclusive = new Date(customTo.getTime() + MS_PER_DAY);
    const capped = new Date(
      Math.min(toExclusive.getTime(), customFrom.getTime() + 730 * MS_PER_DAY),
    );
    return build('custom', customFrom, capped, formatCustomLabel(customFrom, customTo));
  }

  const preset: DashboardRangePreset =
    rawRange && isPreset(rawRange) ? rawRange : DEFAULT_DASHBOARD_RANGE;
  const { from, to } = resolveDateRange(preset, DEFAULT_DASHBOARD_RANGE);
  return build(preset, from, to, PRESET_LABELS[preset]);
}

const PRESET_LABELS: Record<DashboardRangePreset, string> = {
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  this_quarter: 'This quarter',
  this_year: 'This year',
};

function build(
  preset: DashboardRange['preset'],
  from: Date,
  to: Date,
  label: string,
): DashboardRange {
  const spanMs = Math.max(MS_PER_DAY, to.getTime() - from.getTime());
  return {
    preset,
    from,
    to,
    days: Math.max(1, Math.round(spanMs / MS_PER_DAY)),
    label,
    prior: {
      from: new Date(from.getTime() - spanMs),
      to: new Date(from.getTime()),
    },
  };
}

function formatCustomLabel(from: Date, toInclusive: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return `${fmt(from)} – ${fmt(toInclusive)}`;
}

/**
 * Serialize a range back into search params, preserving any unrelated
 * keys the caller passes in (`view=rep:…` most importantly, so
 * changing the date doesn't silently reset the owner filter).
 */
export function dashboardRangeToSearchParams(
  range: { preset: DashboardRange['preset']; from?: Date; to?: Date },
  keep?: URLSearchParams,
): URLSearchParams {
  const out = new URLSearchParams(keep?.toString() ?? '');
  out.delete('from');
  out.delete('to');
  if (range.preset === 'custom' && range.from && range.to) {
    out.set('range', 'custom');
    out.set('from', isoDay(range.from));
    // `to` is stored exclusive internally; the URL carries the
    // inclusive day the user actually picked.
    out.set('to', isoDay(new Date(range.to.getTime() - MS_PER_DAY)));
  } else {
    out.set('range', range.preset);
  }
  return out;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
