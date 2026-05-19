/**
 * Pure date-math helpers. Deliberately NOT `server-only` — the label
 * map + `parseDateRangePreset` are consumed by the client-side filter
 * bar. No DB or env access happens here.
 */

import type { DateRange, DateRangePreset } from './types';

/**
 * Resolves a `DateRangePreset | DateRange` into a concrete `{ from, to }`
 * pair of UTC Date instances. All times are end-of-day-exclusive on `to`
 * (i.e. `to` is the first millisecond of the day AFTER the range ends),
 * which simplifies range predicates: `closed_at >= from AND closed_at < to`.
 *
 * `defaultPreset` is used when the caller passes a falsy/unsupported
 * value — avoids forcing every runner to repeat the same defaulting logic.
 */
export function resolveDateRange(
  input: DateRangePreset | DateRange | undefined,
  defaultPreset: DateRangePreset,
): { from: Date; to: Date; presetUsed: DateRangePreset | 'custom' } {
  if (input && typeof input === 'object' && 'from' in input && 'to' in input) {
    return {
      from: new Date(input.from),
      to: new Date(input.to),
      presetUsed: 'custom',
    };
  }
  const preset =
    typeof input === 'string' && PRESETS.has(input as DateRangePreset)
      ? (input as DateRangePreset)
      : defaultPreset;
  return { ...resolvePreset(preset), presetUsed: preset };
}

const PRESETS = new Set<DateRangePreset>([
  'today',
  'last_7d',
  'last_30d',
  'last_90d',
  'this_quarter',
  'this_year',
  'all_time',
]);

function resolvePreset(preset: DateRangePreset): { from: Date; to: Date } {
  const now = new Date();
  const todayUtcStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const tomorrowUtcStart = new Date(todayUtcStart);
  tomorrowUtcStart.setUTCDate(tomorrowUtcStart.getUTCDate() + 1);

  switch (preset) {
    case 'today':
      return { from: todayUtcStart, to: tomorrowUtcStart };
    case 'last_7d':
      return {
        from: addDays(todayUtcStart, -7),
        to: tomorrowUtcStart,
      };
    case 'last_30d':
      return {
        from: addDays(todayUtcStart, -30),
        to: tomorrowUtcStart,
      };
    case 'last_90d':
      return {
        from: addDays(todayUtcStart, -90),
        to: tomorrowUtcStart,
      };
    case 'this_quarter': {
      const q = Math.floor(now.getUTCMonth() / 3);
      const qStart = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      const qEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
      return { from: qStart, to: qEnd };
    }
    case 'this_year': {
      const yStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const yEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      return { from: yStart, to: yEnd };
    }
    case 'all_time':
      // Use a very-early start that's still indexable.
      return {
        from: new Date(Date.UTC(2000, 0, 1)),
        to: tomorrowUtcStart,
      };
  }
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Parses a string from URL search params into a valid preset, or null. */
export function parseDateRangePreset(
  raw: string | string[] | undefined,
): DateRangePreset | null {
  if (typeof raw !== 'string') return null;
  return PRESETS.has(raw as DateRangePreset) ? (raw as DateRangePreset) : null;
}

export const DATE_RANGE_PRESET_LABELS: Record<DateRangePreset, string> = {
  today: 'Today',
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  this_quarter: 'This quarter',
  this_year: 'This year',
  all_time: 'All time',
};
