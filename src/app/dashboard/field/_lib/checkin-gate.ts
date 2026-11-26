import { checkinWindowState } from '@/lib/field/checkin-window';

import { formatTimeInTz } from './datetime';

/**
 * Check-in button copy from the server-computed window (`checkinOpensAt` /
 * `checkinClosesAt` on DayMeeting, or the 422 `outside_window` body). Pure.
 * Returns null while the window is open.
 */
export function checkinGateLabel(
  opensAt: string | Date | null | undefined,
  closesAt: string | Date | null | undefined,
  now: Date,
  tz: string,
): string | null {
  if (!opensAt || !closesAt) return null;
  const w = { opensAt: new Date(opensAt), closesAt: new Date(closesAt) };
  if (Number.isNaN(w.opensAt.getTime()) || Number.isNaN(w.closesAt.getTime())) return null;
  const state = checkinWindowState(w, now);
  if (state === 'before') return `Check-in opens at ${formatTimeInTz(w.opensAt, tz)}`;
  if (state === 'after') return `Check-in closed at ${formatTimeInTz(w.closesAt, tz)}`;
  return null;
}
