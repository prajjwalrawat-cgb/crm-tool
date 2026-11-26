/**
 * Check-in time window: check-in is open from `opensBefore` minutes before the
 * meeting starts to `closesAfter` minutes after it ends, both ends inclusive.
 * Pure, so the service, the day view and the self-tests share one rule.
 */

export type CheckinWindowSettings = { checkinOpensBeforeMin: number; checkinClosesAfterMin: number };
export type CheckinWindow = { opensAt: Date; closesAt: Date };

const MIN = 60_000;

export function checkinWindow(meeting: { startAt: Date; endAt: Date }, s: CheckinWindowSettings): CheckinWindow {
  return {
    opensAt: new Date(meeting.startAt.getTime() - s.checkinOpensBeforeMin * MIN),
    closesAt: new Date(meeting.endAt.getTime() + s.checkinClosesAfterMin * MIN),
  };
}

/** 'before' when the window has not opened, 'after' when it has closed, else 'open'. */
export function checkinWindowState(w: CheckinWindow, now: Date): 'before' | 'open' | 'after' {
  const t = now.getTime();
  if (t < w.opensAt.getTime()) return 'before';
  if (t > w.closesAt.getTime()) return 'after';
  return 'open';
}
