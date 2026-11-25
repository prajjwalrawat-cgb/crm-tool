import type { MeetingStatus } from '@/db/schema/enums';
import type { DayMeeting } from '@/lib/field/day';

import { isoToZonedInput } from './datetime';

/**
 * Pure layout maths for the manager's day board (/dashboard/field/today).
 * Every time is placed by its wall clock in the TENANT timezone. Percentages
 * are of the visible window (default 09:00–19:00).
 */

export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 19;

export type BlockGeometry = { leftPct: number; widthPct: number; clippedStart: boolean; clippedEnd: boolean };
export type BlockColor = 'planned' | 'onsite' | 'done' | 'atrisk';

type When = Date | string;

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Minutes after local midnight of `at` in `tz`. */
function localMinutes(at: Date, tz: string): number {
  const hhmm = isoToZonedInput(at, tz).slice(11);
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Horizontal position of a meeting. The end is measured from the start's local
 * day (start + duration), so a meeting running past midnight clips at the right
 * edge instead of wrapping. Times outside the window clamp to its edge and set
 * clippedStart / clippedEnd (the UI draws a marker there).
 */
export function blockGeometry(
  startAt: When,
  endAt: When,
  tz: string,
  dayStartHour = DAY_START_HOUR,
  dayEndHour = DAY_END_HOUR,
): BlockGeometry {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const winStart = dayStartHour * 60;
  const winEnd = dayEndHour * 60;
  const span = winEnd - winStart;
  const s = localMinutes(start, tz);
  const e = s + Math.max(0, (end.getTime() - start.getTime()) / 60_000);
  const clamp = (m: number) => Math.min(winEnd, Math.max(winStart, m));
  const cs = clamp(s);
  const ce = clamp(e);
  return {
    leftPct: round(((cs - winStart) / span) * 100),
    widthPct: round(((ce - cs) / span) * 100),
    clippedStart: s < winStart,
    clippedEnd: e > winEnd,
  };
}

const ONSITE: MeetingStatus[] = ['arrived', 'checked_in'];

/** Block colour: at risk wins; on site = arrived / checked in; done = MOM logged; else planned. */
export function blockColor(m: Pick<DayMeeting, 'status' | 'risk'>): BlockColor {
  if (m.risk.reasons.length > 0) return 'atrisk';
  if (m.status === 'mom_logged') return 'done';
  if (ONSITE.includes(m.status)) return 'onsite';
  return 'planned';
}

export type LaneItem = Pick<DayMeeting, 'id' | 'type' | 'status' | 'lat' | 'lng' | 'risk'> & {
  startAt: When;
  endAt: When;
};

export type LaneBlock<T extends LaneItem> = { meeting: T; row: number; overlaps: boolean };

export type LaneConnector = {
  fromId: string;
  toId: string;
  /** Drive minutes the risk engine estimated for this leg; null when it did not look. */
  minutes: number | null;
  estimate: boolean;
  /** The later meeting is flagged travel_gap. */
  tight: boolean;
  fromEnd: When;
  toStart: When;
  leftPct: number;
  widthPct: number;
};

const ms = (w: When) => new Date(w).getTime();

/**
 * One rep's lane: cancelled meetings dropped, the rest sorted by start and put
 * in the first sub-row whose last block ends at or before this one starts.
 * `overlaps` marks blocks whose time range intersects another block's.
 * Connectors join consecutive physical meetings that have a pinned site (the
 * same pairs the risk engine measures), carrying the later meeting's drive
 * estimate and travel_gap flag.
 */
export function layoutLane<T extends LaneItem>(
  meetings: T[],
  tz: string,
  dayStartHour = DAY_START_HOUR,
  dayEndHour = DAY_END_HOUR,
): { rows: number; blocks: Array<LaneBlock<T>>; connectors: LaneConnector[] } {
  const list = meetings
    .filter((m) => m.status !== 'cancelled')
    .sort((a, b) => ms(a.startAt) - ms(b.startAt) || ms(a.endAt) - ms(b.endAt) || a.id.localeCompare(b.id));

  const rowEnds: number[] = [];
  const blocks: Array<LaneBlock<T>> = list.map((m) => {
    let row = rowEnds.findIndex((end) => end <= ms(m.startAt));
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(ms(m.endAt));
    } else {
      rowEnds[row] = ms(m.endAt);
    }
    const overlaps = list.some((o) => o !== m && ms(o.startAt) < ms(m.endAt) && ms(m.startAt) < ms(o.endAt));
    return { meeting: m, row, overlaps };
  });

  const sited = list.filter((m) => m.type === 'physical' && m.lat !== null && m.lng !== null);
  const connectors: LaneConnector[] = [];
  for (let i = 1; i < sited.length; i++) {
    const prev = sited[i - 1]!;
    const next = sited[i]!;
    const g =
      ms(next.startAt) > ms(prev.endAt)
        ? blockGeometry(prev.endAt, next.startAt, tz, dayStartHour, dayEndHour)
        : { ...blockGeometry(prev.endAt, prev.endAt, tz, dayStartHour, dayEndHour), widthPct: 0 };
    connectors.push({
      fromId: prev.id,
      toId: next.id,
      minutes: next.risk.estDriveMin,
      estimate: next.risk.estimate,
      tight: next.risk.reasons.includes('travel_gap'),
      fromEnd: prev.endAt,
      toStart: next.startAt,
      leftPct: g.leftPct,
      widthPct: g.widthPct,
    });
  }

  return { rows: Math.max(1, rowEnds.length), blocks, connectors };
}
