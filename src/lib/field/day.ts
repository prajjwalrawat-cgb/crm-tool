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

import { checkinWindow } from './checkin-window';
import { lateBy } from './late';
import { toPickerCompany, type PickerCompany } from './picker-link';
import { computeKpis } from './kpis';
import { asActor, mapsOf, nowOf, type FieldDeps } from './internal';
import { estimateDriveMinutes } from './geo';
import { driveKey, driveLookupMany, driveStore, type DrivePair } from './maps/cached';
import type { DriveResult } from './maps';
import { computeRisks, type MeetingRisk, type RiskMeeting } from './risk';
import { fieldUserScope } from './scope';
import { getFieldSettings } from './settings';
import { FieldError, type FieldActor, type RiskReason } from './types';

export type DayMeeting = Meeting & {
  deal: {
    id: string;
    name: string;
    amountMinor: number;
    currency: string;
    stage: DealStage;
    companyId: string | null;
  } | null;
  contact: { id: string; name: string; companyId: string | null } | null;
  /** With its site (line, status, point) so the edit form can prefill and explain the address. */
  company: PickerCompany | null;
  /** Minutes late of the first accepted check-in (lateBy), null when on time or not checked in. */
  lateMin: number | null;
  /**
   * Every attempt, oldest first: kind 'in' / 'out' and 'verify' (a later
   * verification, never a check-in). `visitVerified` / `visitVerifiedHow` /
   * `visitVerifiedAt` come from the meeting row itself.
   */
  checkins: MeetingCheckin[];
  outcome: MeetingOutcome | null;
  risk: MeetingRisk;
  /** Check-in time window (ISO), from `checkinWindow`; the UI never re-derives it. */
  checkinOpensAt: string;
  checkinClosesAt: string;
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

/** Spec default tenant timezone (organization_settings.timezone default). */
const DEFAULT_TZ = 'Asia/Kolkata';

function validTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
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
    const tz = validTz(org.timezone);
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

    // Phase 1: one read transaction, including the cached drive times for every pair.
    const snap = await tenantTransaction(async (tx) => {
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
          dealCompanyId: deals.companyId,
          contactId: contacts.id,
          contactFirst: contacts.firstName,
          contactLast: contacts.lastName,
          contactCompanyId: contacts.companyId,
          companyId: companies.id,
          companyName: companies.name,
          companyAddress: companies.address,
          companyCity: companies.city,
          companyState: companies.state,
          companyPostalCode: companies.postalCode,
          companyLat: companies.lat,
          companyLng: companies.lng,
          companyGeocodeStatus: companies.geocodeStatus,
        })
        .from(meetings)
        .leftJoin(deals, eq(deals.id, meetings.dealId))
        .leftJoin(contacts, eq(contacts.id, meetings.contactId))
        .leftJoin(companies, eq(companies.id, meetings.companyId))
        .where(and(...conds))
        .orderBy(asc(meetings.startAt), asc(meetings.id));
      if (rows.length === 0) return null;

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
      const outcomeIds = new Set(outcomes.map((o) => o.meetingId));
      const riskInput: RiskMeeting[] = rows.map(({ meeting: m }) => ({
        id: m.id,
        ownerId: m.ownerId,
        type: m.type,
        status: m.status,
        startAt: m.startAt,
        endAt: m.endAt,
        site: m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : null,
        checkedOutAt: m.checkedOutAt,
        hasOutcome: outcomeIds.has(m.id),
      }));
      const pairs = await drivePairsOf(riskInput, now, settings);
      const cached = await driveLookupMany(tx, actor.tenantId, pairs, { now: () => now });
      return { rows, checkins, outcomes, people, settings, riskInput, pairs, cached };
    });
    if (!snap) return empty;
    const { rows, checkins, outcomes, people, settings, riskInput, pairs, cached } = snap;

    // Phase 2: provider calls for cache misses, with no transaction open. A pair whose
    // later meeting has started is never re-priced: cache only, else no drive figure.
    const misses = pairs.filter((p) => p.next.startAt.getTime() > now.getTime() && !cached.has(p.key));
    const fetched = new Map<string, DriveResult>();
    await eachLimited(misses, DRIVE_CONCURRENCY, async (p) => {
      let res: DriveResult;
      try {
        res = await maps.driveMinutes(p.a, p.b, p.departAt);
      } catch {
        res = { minutes: estimateDriveMinutes(p.a, p.b), estimate: true };
      }
      fetched.set(p.key, res);
    });

    // Phase 3: one short write transaction storing the real (non-estimate) answers.
    const toStore = misses.filter((p) => fetched.get(p.key)?.estimate === false);
    if (toStore.length > 0) {
      try {
        await tenantTransaction(async (tx) => {
          for (const p of toStore) await driveStore(tx, actor.tenantId, p, fetched.get(p.key)!, maps.name, { now: () => now });
        });
      } catch (err) {
        // A cache write must never break the board; the next refresh refetches.
        console.warn('[field] drive cache write failed', err);
      }
    }

    const risks = await computeRisks(
      riskInput,
      now,
      { graceMin: settings.graceMin, momDueHours: settings.momDueHours },
      async (a, b, departAt) => {
        const k = driveKey(a, b, departAt);
        return cached.get(k) ?? fetched.get(k) ?? null;
      },
    );
    // A started meeting's pair is not re-priced; keep a travel_gap the scan stored on it.
    for (const { meeting: m } of rows) {
      const r = risks.get(m.id)!;
      if (m.startAt.getTime() <= now.getTime() && m.atRiskReasons.includes('travel_gap') && !r.reasons.includes('travel_gap')) {
        r.reasons = REASON_ORDER.filter((x) => x === 'travel_gap' || r.reasons.includes(x));
      }
    }

    const checkinsBy = new Map<string, MeetingCheckin[]>();
    for (const c of checkins) checkinsBy.set(c.meetingId, [...(checkinsBy.get(c.meetingId) ?? []), c]);
    const outcomeBy = new Map(outcomes.map((o) => [o.meetingId, o]));

    const all: DayMeeting[] = rows.map((r) => {
      const win = checkinWindow(r.meeting, settings);
      const mine = checkinsBy.get(r.meeting.id) ?? [];
      const firstIn = mine.find((c) => c.kind === 'in' && c.accepted);
      return {
      ...r.meeting,
      deal:
        r.dealId !== null
          ? {
              id: r.dealId,
              name: r.dealName!,
              amountMinor: r.dealAmountMinor!,
              currency: r.dealCurrency!,
              stage: r.dealStage!,
              companyId: r.dealCompanyId,
            }
          : null,
      contact:
        r.contactId !== null
          ? {
              id: r.contactId,
              name: fullName(r.contactFirst, r.contactLast) || 'Unnamed contact',
              companyId: r.contactCompanyId,
            }
          : null,
      company:
        r.companyId !== null
          ? toPickerCompany({
              id: r.companyId,
              name: r.companyName!,
              address: r.companyAddress,
              city: r.companyCity,
              state: r.companyState,
              postalCode: r.companyPostalCode,
              lat: r.companyLat,
              lng: r.companyLng,
              geocodeStatus: r.companyGeocodeStatus,
            })
          : null,
      lateMin: lateBy(r.meeting, firstIn?.capturedAt, settings.graceMin),
      checkins: mine,
      outcome: outcomeBy.get(r.meeting.id) ?? null,
      risk: risks.get(r.meeting.id)!,
      checkinOpensAt: win.opensAt.toISOString(),
      checkinClosesAt: win.closesAt.toISOString(),
      };
    });

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
}

const REASON_ORDER: RiskReason[] = ['no_checkin', 'travel_gap', 'overlap', 'mom_missing'];

/** Parallel provider calls per getDay. */
const DRIVE_CONCURRENCY = 4;

type DayPair = DrivePair & { key: string; next: RiskMeeting };

/** Every drive pair computeRisks will ask about (pure: the collecting pass makes no lookups). */
async function drivePairsOf(
  input: RiskMeeting[],
  now: Date,
  s: { graceMin: number; momDueHours: number },
): Promise<DayPair[]> {
  const byKey = new Map<string, DayPair>();
  await computeRisks(input, now, s, async (a, b, departAt, next) => {
    const key = driveKey(a, b, departAt);
    const seen = byKey.get(key);
    // Same lookup for two pairs: keep the one that may still be priced (later meeting not started).
    if (!seen || (seen.next.startAt.getTime() <= now.getTime() && next.startAt.getTime() > now.getTime())) {
      byKey.set(key, { a, b, departAt, key, next });
    }
    return null;
  });
  return [...byKey.values()];
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
