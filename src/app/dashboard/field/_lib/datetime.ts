/**
 * Tenant-timezone date helpers for the field pages. Pure (Intl only), safe in
 * client and server code. Form inputs (`<input type="datetime-local">`) hold a
 * wall-clock time in the TENANT timezone, never the browser's.
 */

/** Spec default tenant timezone (organization_settings.timezone default). */
export const DEFAULT_TZ = 'Asia/Kolkata';

export function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsIn(at: Date, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Local wall clock minus UTC, in minutes, at instant `at` in `tz`. */
function offsetMinutes(at: Date, tz: string): number {
  const p = partsIn(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

function formatOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  return `${sign}${pad(Math.trunc(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * `'2026-11-25T10:00'` (wall clock in `tz`) → `'2026-11-25T10:00:00+05:30'`.
 * Null when the value is not a real date-time.
 */
export function zonedInputToIso(value: string, tz: string): string | null {
  const m = INPUT_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) {
    return null;
  }
  const zone = safeTz(tz);
  const guess = probe.getTime();
  // Two passes settle the offset around DST changes.
  const first = guess - offsetMinutes(new Date(guess), zone) * 60_000;
  const off = offsetMinutes(new Date(first), zone);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${formatOffset(off)}`;
}

/** Instant → `'YYYY-MM-DDTHH:mm'` wall clock in `tz` (for datetime-local inputs). */
export function isoToZonedInput(at: Date | string, tz: string): string {
  const p = partsIn(new Date(at), safeTz(tz));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Tenant-local calendar date `'YYYY-MM-DD'`. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  const p = partsIn(now, safeTz(tz));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `'10:00 am'` in `tz`. */
export function formatTimeInTz(at: Date | string, tz: string): string {
  const p = partsIn(new Date(at), safeTz(tz));
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;
}

/** `'Wed, 25 Nov'` for a `'YYYY-MM-DD'` date. */
export function formatDayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date `'YYYY-MM-DD'`. */
export function isValidDate(date: string | null | undefined): date is string {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === date;
}

/** `'YYYY-MM-DD'` moved by `days` calendar days. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
