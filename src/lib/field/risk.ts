import type { MeetingStatus } from '@/db/schema/enums';
import type { LatLng, RiskReason } from './types';

export type RiskMeeting = {
  id: string;
  ownerId: string;
  type: 'physical' | 'virtual';
  status: MeetingStatus;
  startAt: Date;
  endAt: Date;
  site: LatLng | null;
  checkedOutAt: Date | null;
  hasOutcome: boolean;
};

export type DriveFn = (a: LatLng, b: LatLng, departAt: Date) => Promise<{ minutes: number; estimate: boolean }>;

export type MeetingRisk = {
  reasons: RiskReason[];
  travelGapMin: number | null;
  estDriveMin: number | null;
  estimate: boolean;
};

const REASON_ORDER: RiskReason[] = ['no_checkin', 'travel_gap', 'overlap', 'mom_missing'];
const PRE_CHECKIN: MeetingStatus[] = ['planned', 'en_route', 'arrived'];
const MIN = 60_000;

export async function computeRisks(
  meetings: RiskMeeting[],
  now: Date,
  s: { graceMin: number; momDueHours: number },
  drive: DriveFn,
): Promise<Map<string, MeetingRisk>> {
  const out = new Map<string, MeetingRisk>();
  const flags = new Map<string, Set<RiskReason>>();
  for (const m of meetings) {
    out.set(m.id, { reasons: [], travelGapMin: null, estDriveMin: null, estimate: false });
    flags.set(m.id, new Set());
  }

  const byOwner = new Map<string, RiskMeeting[]>();
  for (const m of meetings) {
    if (m.status === 'cancelled') continue;
    const list = byOwner.get(m.ownerId);
    if (list) list.push(m);
    else byOwner.set(m.ownerId, [m]);

    const f = flags.get(m.id)!;
    if (m.type === 'physical' && PRE_CHECKIN.includes(m.status) && now.getTime() > m.startAt.getTime() + s.graceMin * MIN) {
      f.add('no_checkin');
    }
    if (m.checkedOutAt && !m.hasOutcome && m.checkedOutAt.getTime() + s.momDueHours * 60 * MIN < now.getTime()) {
      f.add('mom_missing');
    }
  }

  for (const list of byOwner.values()) {
    list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime());

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].startAt.getTime() >= list[i].endAt.getTime()) continue;
        if (list[i].startAt.getTime() < list[j].endAt.getTime()) {
          flags.get(list[i].id)!.add('overlap');
          flags.get(list[j].id)!.add('overlap');
        }
      }
    }

    const physical = list.filter((m) => m.type === 'physical' && m.site);
    for (let i = 1; i < physical.length; i++) {
      const prev = physical[i - 1];
      const next = physical[i];
      const gapMin = Math.round((next.startAt.getTime() - prev.endAt.getTime()) / MIN);
      const d = await drive(prev.site!, next.site!, prev.endAt);
      const r = out.get(next.id)!;
      r.estDriveMin = d.minutes;
      r.estimate = d.estimate;
      // Overlapping pair: the overlap reason covers it; no negative gap, no travel_gap.
      if (gapMin < 0) continue;
      r.travelGapMin = gapMin;
      if (d.minutes > gapMin) flags.get(next.id)!.add('travel_gap');
    }
  }

  for (const [id, f] of flags) out.get(id)!.reasons = REASON_ORDER.filter((r) => f.has(r));
  return out;
}

export function diffReasons(prev: string[], next: string[]): { added: RiskReason[]; removed: RiskReason[] } {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    added: REASON_ORDER.filter((r) => n.has(r) && !p.has(r)),
    removed: REASON_ORDER.filter((r) => p.has(r) && !n.has(r)),
  };
}
