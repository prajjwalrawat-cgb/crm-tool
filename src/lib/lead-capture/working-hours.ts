import type { WorkingHours } from '@/db/schema/lead-capture';

import { WEEKDAYS, type Weekday } from './constants';

/**
 * Working-hours math in a user's own timezone. Pure. `null` working hours
 * means "always on" (24/7), which is also the default for a user with no
 * routing profile.
 *
 * Each weekday has at most one window ["HH:MM","HH:MM"], end > start, both in
 * the user's tz. Overnight windows are not supported (a B2B sales rep's day).
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

type LocalParts = { year: number; month: number; day: number; weekday: Weekday; minuteOfDay: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function localParts(at: Date, tz: string): LocalParts & { second: number } {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = String(parts.weekday).toLowerCase().slice(0, 3) as Weekday;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) of `tz` from UTC at instant `at`: local wall clock − UTC. */
function tzOffsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minuteOfDay / 60), p.minuteOfDay % 60, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of local wall-clock time (y-m-d, minuteOfDay) in `tz`. */
function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass settles DST transitions.
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function dayWindow(wh: WorkingHours, weekday: Weekday): [number, number] | null {
  const w = wh.days[weekday];
  if (!w) return null;
  const start = parseHHMM(w[0]);
  const end = parseHHMM(w[1]);
  if (start === null || end === null || end <= start) return null;
  return [start, end];
}

/** True if `at` falls inside the working window for that local day. */
export function isWithinWorkingHours(wh: WorkingHours | null | undefined, at: Date): boolean {
  if (!wh) return true;
  const p = localParts(at, wh.tz);
  const w = dayWindow(wh, p.weekday);
  return !!w && p.minuteOfDay >= w[0] && p.minuteOfDay < w[1];
}

/** Working windows (UTC instants) starting from the local day containing `from`. */
function* windowsFrom(wh: WorkingHours, from: Date, maxDays = 21): Generator<[Date, Date]> {
  const p0 = localParts(from, wh.tz);
  // Walk local calendar days via a UTC-noon anchor (immune to DST).
  const anchor = Date.UTC(p0.year, p0.month - 1, p0.day, 12);
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(anchor + i * DAY);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = WEEKDAYS[d.getUTCDay()]!;
    const w = dayWindow(wh, weekday);
    if (!w) continue;
    yield [zonedToUtc(y, m, day, w[0], wh.tz), zonedToUtc(y, m, day, w[1], wh.tz)];
  }
}

/** Start of the next working window at or after `at` (or `at` itself if inside one). */
export function nextWorkingStart(wh: WorkingHours | null | undefined, at: Date): Date | null {
  if (!wh) return at;
  for (const [start, end] of windowsFrom(wh, at)) {
    if (end.getTime() <= at.getTime()) continue;
    return start.getTime() > at.getTime() ? start : at;
  }
  return null;
}

/**
 * `start` + `minutes` of WORKING time. A 30-minute SLA on a lead assigned at
 * 18:15 to a rep whose day ends 18:30 is due at 09:45 the next working day,
 * not 18:45. With no working hours (24/7) this is plain addition. If the
 * schedule has no working day within three weeks, falls back to plain
 * addition rather than returning a far-future date.
 */
export function addWorkingMinutes(start: Date, minutes: number, wh: WorkingHours | null | undefined): Date {
  if (!wh) return new Date(start.getTime() + minutes * MINUTE);
  let remaining = minutes * MINUTE;
  for (const [ws, we] of windowsFrom(wh, start)) {
    if (we.getTime() <= start.getTime()) continue;
    const from = Math.max(ws.getTime(), start.getTime());
    const available = we.getTime() - from;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
  }
  return new Date(start.getTime() + minutes * MINUTE);
}

/** Validate a WorkingHours value from user input. Returns an error or null. */
export function validateWorkingHours(wh: WorkingHours): string | null {
  if (!isValidTimeZone(wh.tz)) return `unknown timezone: ${wh.tz}`;
  for (const [day, w] of Object.entries(wh.days)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return `unknown day: ${day}`;
    if (!w) continue;
    const s = parseHHMM(w[0]);
    const e = parseHHMM(w[1]);
    if (s === null || e === null) return `bad time on ${day}`;
    if (e <= s) return `${day}: end must be after start`;
  }
  return null;
}
