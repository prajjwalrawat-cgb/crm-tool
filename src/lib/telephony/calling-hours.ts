import type { CallingHours } from '@/db/schema/telephony';

/**
 * Calling-hours window, every day, in the tenant's timezone. Pure. The
 * default 09:00–21:00 is configurable; it is a product setting, not a
 * statement that any window is compliant — see docs/telephony.md.
 */

export const DEFAULT_CALLING_HOURS: CallingHours = { tz: 'Asia/Kolkata', start: '09:00', end: '21:00' };

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

function localMinute(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function isWithinCallingHours(hours: CallingHours | null | undefined, at: Date = new Date()): boolean {
  const h = hours ?? DEFAULT_CALLING_HOURS;
  const start = toMinutes(h.start);
  const end = toMinutes(h.end);
  if (start === null || end === null || end <= start) return true;
  let m: number;
  try {
    m = localMinute(at, h.tz);
  } catch {
    m = localMinute(at, DEFAULT_CALLING_HOURS.tz);
  }
  return m >= start && m < end;
}

export function validateCallingHours(h: CallingHours): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: h.tz });
  } catch {
    return `unknown timezone: ${h.tz}`;
  }
  const s = toMinutes(h.start);
  const e = toMinutes(h.end);
  if (s === null || e === null) return 'times must be HH:MM';
  if (e <= s) return 'end must be after start';
  return null;
}
