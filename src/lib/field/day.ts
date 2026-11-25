import 'server-only';

import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';

import {
  companies,
  contacts,
  deals,
  meetingCheckins,
  meetingOutcomes,
  meetings,
  users,
  type Meeting,
  type MeetingCheckin,
  type MeetingOutcome,
} from '@/db/schema';
import type { DealStage } from '@/db/schema/enums';
import { tenantTransaction } from '@/lib/db-context';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { narrowToOwner } from '@/lib/reports/manager/scope';

import { computeKpis } from './kpis';
import { asActor, mapsOf, nowOf, type FieldDeps } from './internal';
import { driveMinutesCached } from './maps/cached';
import { computeRisks, type MeetingRisk, type RiskMeeting } from './risk';
import { fieldUserScope } from './scope';
import { getFieldSettings } from './settings';
import { FieldError, type FieldActor } from './types';

export type DayMeeting = Meeting & {
  deal: { id: string; name: string; amountMinor: number; currency: string; stage: DealStage } | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  checkins: MeetingCheckin[];
  outcome: MeetingOutcome | null;
  risk: MeetingRisk;
};

export type DayView = {
  date: string;
  tz: string;
  kpis: ReturnType<typeof computeKpis>;
  reps: Array<{ userId: string; name: string; meetings: DayMeeting[] }>;
  /** Manager without configured reports: widened to the whole tenant. */
  scopeFallback: boolean;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validTz(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Local wall-clock minus UTC, in ms, for `at` in `tz`. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts: Record<string, number> = {};
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
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function localMidnight(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

/** UTC instants of [date 00:00, date+1 00:00) in `tz`. Throws `validation` on a malformed date. */
export function tenantDayBounds(date: string, tz: string): { start: Date; end: Date } {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (!m || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new FieldError('validation', 'date must be a real YYYY-MM-DD');
  }
  const zone = validTz(tz);
  return { start: localMidnight(y, mo, d, zone), end: localMidnight(y, mo, d + 1, zone) };
}

const fullName = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(' ').trim();

export function getDay(
  actor: FieldActor,
  q: { date: string; repId?: string; atRiskOnly?: boolean },
  deps?: FieldDeps,
): Promise<DayView> {
  return asActor(actor, async () => {
    const org = await getOrgSettings(actor.tenantId);
    const tz = validTz(org.timezone || 'UTC');
    const { start, end } = tenantDayBounds(q.date, tz);
    const baseScope = await fieldUserScope(actor);
    const scope = narrowToOwner(baseScope, q.repId);
    const now = nowOf(deps);
    const maps = mapsOf(deps);
    const empty: DayView = {
      date: q.date,
      tz,
      kpis: computeKpis([], org.defaultCurrency),
      reps: [],
      scopeFallback: baseScope.fallback,
    };
    if (scope.userIds !== null && scope.userIds.length === 0) return empty;

    return tenantTransaction(async (tx) => {
      const conds = [eq(meetings.tenantId, actor.tenantId), gte(meetings.startAt, start), lt(meetings.startAt, end)];
      if (scope.userIds !== null) conds.push(inArray(meetings.ownerId, scope.userIds));
      const rows = await tx
        .select({
          meeting: meetings,
          dealId: deals.id,
          dealName: deals.name,
          dealAmountMinor: deals.amountMinor,
          dealCurrency: deals.currency,
          dealStage: deals.stage,
          contactId: contacts.id,
          contactFirst: contacts.firstName,
          contactLast: contacts.lastName,
          companyId: companies.id,
          companyName: companies.name,
        })
        .from(meetings)
        .leftJoin(deals, eq(deals.id, meetings.dealId))
        .leftJoin(contacts, eq(contacts.id, meetings.contactId))
        .leftJoin(companies, eq(companies.id, meetings.companyId))
        .where(and(...conds))
        .orderBy(asc(meetings.startAt), asc(meetings.id));
      if (rows.length === 0) return empty;

      const ids = rows.map((r) => r.meeting.id);
      const ownerIds = [...new Set(rows.map((r) => r.meeting.ownerId))];
      // Sequential on purpose: one transaction = one connection.
      const checkins = await tx
        .select()
        .from(meetingCheckins)
        .where(and(eq(meetingCheckins.tenantId, actor.tenantId), inArray(meetingCheckins.meetingId, ids)))
        .orderBy(asc(meetingCheckins.capturedAt));
      const outcomes = await tx
        .select()
        .from(meetingOutcomes)
        .where(and(eq(meetingOutcomes.tenantId, actor.tenantId), inArray(meetingOutcomes.meetingId, ids)));
      const people = await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds));
      const settings = await getFieldSettings(tx, actor.tenantId);
      const checkinsBy = new Map<string, MeetingCheckin[]>();
      for (const c of checkins) checkinsBy.set(c.meetingId, [...(checkinsBy.get(c.meetingId) ?? []), c]);
      const outcomeBy = new Map(outcomes.map((o) => [o.meetingId, o]));

      const riskInput: RiskMeeting[] = rows.map(({ meeting: m }) => ({
        id: m.id,
        ownerId: m.ownerId,
        type: m.type,
        status: m.status,
        startAt: m.startAt,
        endAt: m.endAt,
        site: m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : null,
        checkedOutAt: m.checkedOutAt,
        hasOutcome: outcomeBy.has(m.id),
      }));
      const risks = await computeRisks(
        riskInput,
        now,
        { graceMin: settings.graceMin, momDueHours: settings.momDueHours },
        (a, b, departAt) => driveMinutesCached(tx, actor.tenantId, a, b, departAt, maps, { now: () => now }),
      );

      const all: DayMeeting[] = rows.map((r) => ({
        ...r.meeting,
        deal:
          r.dealId !== null
            ? {
                id: r.dealId,
                name: r.dealName!,
                amountMinor: r.dealAmountMinor!,
                currency: r.dealCurrency!,
                stage: r.dealStage!,
              }
            : null,
        contact:
          r.contactId !== null ? { id: r.contactId, name: fullName(r.contactFirst, r.contactLast) || 'Unnamed contact' } : null,
        company: r.companyId !== null ? { id: r.companyId, name: r.companyName! } : null,
        checkins: checkinsBy.get(r.meeting.id) ?? [],
        outcome: outcomeBy.get(r.meeting.id) ?? null,
        risk: risks.get(r.meeting.id)!,
      }));

      const kpis = computeKpis(
        all.map((m) => ({
          status: m.status,
          atRisk: m.risk.reasons.length > 0,
          dealId: m.deal?.id ?? null,
          amountMinor: m.deal?.amountMinor ?? null,
          currency: m.deal?.currency ?? null,
        })),
        org.defaultCurrency,
      );

      const shown = q.atRiskOnly ? all.filter((m) => m.risk.reasons.length > 0) : all;
      const nameOf = new Map(people.map((p) => [p.id, fullName(p.firstName, p.lastName) || p.email]));
      const byRep = new Map<string, DayMeeting[]>();
      for (const m of shown) byRep.set(m.ownerId, [...(byRep.get(m.ownerId) ?? []), m]);
      const reps = [...byRep.entries()]
        .map(([userId, list]) => ({ userId, name: nameOf.get(userId) ?? userId, meetings: list }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

      return { date: q.date, tz, kpis, reps, scopeFallback: baseScope.fallback };
    });
  });
}
