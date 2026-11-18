/**
 * Tenant-timezone day math for the manager reports. Pure and client-safe.
 *
 * Every timestamp is stored UTC. A "day" is a calendar day in the tenant's
 * timezone (organization_settings.timezone, default Asia/Kolkata). SQL buckets
 * with `(ts AT TIME ZONE tz)::date`; `localDay` is the same function in JS, so
 * a lead created at 23:50 IST and one at 00:10 IST land on different days in
 * both places.
 *
 * Ranges are [fromDay, toDay] inclusive as calendar days, and
 * [fromTs, toTs) as UTC instants (toTs = start of the day after toDay).
 */

export type Ymd = string; // 'YYYY-MM-DD'

export const RANGE_PRESETS = ['today', '7d', '30d', 'mtd', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const COMPARE_MODES = ['previous', 'yoy', 'none'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  mtd: 'Month to date',
  custom: 'Custom',
};

export type ResolvedRange = {
  preset: RangePreset;
  tz: string;
  fromDay: Ymd;
  toDay: Ymd;
  fromTs: Date;
  toTs: Date;
  days: number;
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function ymdFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try {
    ymdFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Calendar day of instant `at` in `tz`. Mirrors SQL `(at AT TIME ZONE tz)::date`. */
export function localDay(at: Date, tz: string): Ymd {
  return ymdFormatter(tz).format(at);
}

function parseYmd(d: Ymd): { y: number; m: number; day: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y: y!, m: m!, day: day! };
}

export function addDays(d: Ymd, n: number): Ymd {
  const { y, m, day } = parseYmd(d);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return t.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: Ymd, to: Ymd): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.day) - Date.UTC(a.y, a.m - 1, a.day)) / 86_400_000) + 1;
}

/** UTC instant at which local day `d` starts in `tz`. */
export function dayStartUtc(d: Ymd, tz: string): Date {
  const { y, m, day } = parseYmd(d);
  const guess = Date.UTC(y, m - 1, day);
  // Offset of tz at the guess: local wall clock − UTC.
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(t));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return asUtc - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

/** Monday (ISO week start) of the week containing `d`. */
export function weekStart(d: Ymd): Ymd {
  const { y, m, day } = parseYmd(d);
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); // 0 = Sun
  return addDays(d, -((dow + 6) % 7));
}

export function monthStart(d: Ymd): Ymd {
  return `${d.slice(0, 7)}-01`;
}

/** Local weekday (0 = Sun) and hour of `at` in `tz`. */
export function localWeekdayHour(at: Date, tz: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit' }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday));
  return { weekday, hour: Number(p.hour) % 24 };
}

function build(preset: RangePreset, tz: string, fromDay: Ymd, toDay: Ymd): ResolvedRange {
  return {
    preset,
    tz,
    fromDay,
    toDay,
    fromTs: dayStartUtc(fromDay, tz),
    toTs: dayStartUtc(addDays(toDay, 1), tz),
    days: daysBetweenInclusive(fromDay, toDay),
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a preset (or custom from/to days) in the tenant timezone.
 * '7d' / '30d' include today. Custom ranges are clamped to 366 days.
 */
export function resolveRange(args: {
  preset: string | null | undefined;
  from?: string | null;
  to?: string | null;
  tz: string;
  now?: Date;
}): ResolvedRange {
  const tz = isValidTz(args.tz) ? args.tz : 'Asia/Kolkata';
  const today = localDay(args.now ?? new Date(), tz);
  const preset = (RANGE_PRESETS as readonly string[]).includes(args.preset ?? '') ? (args.preset as RangePreset) : '30d';
  switch (preset) {
    case 'today':
      return build('today', tz, today, today);
    case '7d':
      return build('7d', tz, addDays(today, -6), today);
    case '30d':
      return build('30d', tz, addDays(today, -29), today);
    case 'mtd':
      return build('mtd', tz, monthStart(today), today);
    case 'custom': {
      let from = args.from && YMD.test(args.from) ? args.from : addDays(today, -29);
      let to = args.to && YMD.test(args.to) ? args.to : today;
      if (from > to) [from, to] = [to, from];
      if (daysBetweenInclusive(from, to) > 366) from = addDays(to, -365);
      return build('custom', tz, from, to);
    }
  }
}

/** The comparison window: the same length immediately before, or one year earlier. */
export function compareRange(r: ResolvedRange, mode: CompareMode): ResolvedRange | null {
  if (mode === 'none') return null;
  if (mode === 'yoy') {
    const shift = (d: Ymd) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, '-02-28');
    return build(r.preset, r.tz, shift(r.fromDay), shift(r.toDay));
  }
  if (r.preset === 'mtd') {
    // Month-to-date compares with the same number of days of the previous month.
    const prevMonthStart = monthStart(addDays(r.fromDay, -1));
    const to = addDays(prevMonthStart, r.days - 1);
    const prevMonthEnd = addDays(r.fromDay, -1);
    return build(r.preset, r.tz, prevMonthStart, to > prevMonthEnd ? prevMonthEnd : to);
  }
  const to = addDays(r.fromDay, -1);
  return build(r.preset, r.tz, addDays(to, -(r.days - 1)), to);
}

/** Every day in [from, to]. */
export function eachDay(from: Ymd, to: Ymd): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export type Segment = { from: Ymd; to: Ymd; source: 'rollup' | 'live' };

/**
 * Which parts of [fromDay, toDay] are read from the rollup and which live.
 * Rollup-eligible days are [coveredFrom, today − 1]; everything else (today,
 * and any day no finished backfill covers) is computed live.
 */
export function planSegments(fromDay: Ymd, toDay: Ymd, coveredFrom: Ymd | null, today: Ymd): Segment[] {
  if (coveredFrom === null) return [{ from: fromDay, to: toDay, source: 'live' }];
  const yesterday = addDays(today, -1);
  const rFrom = fromDay > coveredFrom ? fromDay : coveredFrom;
  const rTo = toDay < yesterday ? toDay : yesterday;
  if (rFrom > rTo) return [{ from: fromDay, to: toDay, source: 'live' }];
  const out: Segment[] = [];
  if (fromDay < rFrom) out.push({ from: fromDay, to: addDays(rFrom, -1), source: 'live' });
  out.push({ from: rFrom, to: rTo, source: 'rollup' });
  if (rTo < toDay) out.push({ from: addDays(rTo, 1), to: toDay, source: 'live' });
  return out;
}
