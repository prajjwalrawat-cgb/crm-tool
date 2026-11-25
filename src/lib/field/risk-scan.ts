import 'server-only';

import { and, eq, getTableColumns, gte, inArray, lt, ne, sql } from 'drizzle-orm';

import { db } from '@/db';
import { memberships, meetingOutcomes, meetings, organizationSettings, users } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { recordNotification } from '@/lib/notifications/recorder';

import { tenantDayBounds } from './day';
import { mapsOf, publishMeetingUpdated } from './internal';
import type { FieldDeps } from './internal';
import { driveMinutesCached } from './maps/cached';
import { computeRisks, diffReasons, type MeetingRisk, type RiskMeeting } from './risk';
import { getFieldSettings, isWithinTrackingHours } from './settings';
import type { LatLng, RiskReason } from './types';

const HOUR = 3_600_000;
const DEFAULT_TZ = 'Asia/Kolkata';
const REASON_ORDER: RiskReason[] = ['no_checkin', 'travel_gap', 'overlap', 'mom_missing'];

export type RiskScanDeps = FieldDeps & {
  ignoreHours?: boolean;
  /** Test hook: runs after risks are computed and before the write phase. */
  afterCompute?: () => Promise<void>;
};
export type RiskScanResult = { scanned: number; added: number; cleared: number; notified: number };

const TITLE: Record<RiskReason, string> = {
  no_checkin: 'No check-in',
  travel_gap: 'Tight travel',
  overlap: 'Overlapping meetings',
  mom_missing: 'MOM missing',
};

function validTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** YYYY-MM-DD of `at` on the wall clock of `tz`. */
function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function localHm(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h === '24' ? '00' : h}:${m}`;
}

/**
 * Cheap superset of the tenants worth scanning: any non-cancelled meeting starting in
 * [now - 48 h, now + 24 h]. Runs outside RLS (ids only); each tenant is then scanned
 * under its own system context.
 */
export async function tenantsWithMeetingsInWindow(now: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tenantId: meetings.tenantId })
    .from(meetings)
    .where(
      and(
        ne(meetings.status, 'cancelled'),
        gte(meetings.startAt, new Date(now.getTime() - 48 * HOUR)),
        lt(meetings.startAt, new Date(now.getTime() + 24 * HOUR)),
      ),
    );
  return rows.map((r) => r.tenantId);
}

/**
 * Recompute risk for one tenant's recent and today's meetings, persist changed
 * `at_risk_reasons`, and notify the rep and their manager once per newly-appearing
 * reason. A reason that clears and later returns is a new appearance.
 *
 * Three phases, never holding row locks across network calls: (1) one short read tx;
 * (2) risk computation, where each drive lookup runs in its own short sequential
 * transaction (cache read, provider call, cache write); (3) one write tx that applies
 * each change as a compare-and-swap against the state read in (1), notifying only for
 * rows it actually changed. A concurrent edit or scan makes the swap miss; the next run
 * picks it up. The swap also compares updated_at (as exact text), so an owner, type or site
 * edit to the meeting itself during the scan makes it miss. Edits to the OTHER meeting of a
 * pair during a scan are not detected; the next scan corrects them. Idempotent: a second run with the same inputs writes and notifies nothing.
 */
export async function scanTenantRisks(tenantId: string, deps: RiskScanDeps = {}): Promise<RiskScanResult> {
  const now = (deps.now ?? (() => new Date()))();
  const maps = mapsOf(deps);
  const result: RiskScanResult = { scanned: 0, added: 0, cleared: 0, notified: 0 };

  return runWithSystemContext(tenantId, async () => {
    // Phase 1: read.
    const snap = await tenantTransaction(async (tx) => {
      const [org] = await tx
        .select({ timezone: organizationSettings.timezone })
        .from(organizationSettings)
        .where(eq(organizationSettings.tenantId, tenantId))
        .limit(1);
      const tz = validTz(org?.timezone);
      const settings = await getFieldSettings(tx, tenantId);
      if (!deps.ignoreHours && !isWithinTrackingHours(settings, now, tz)) return null;

      const windowStart = new Date(now.getTime() - 48 * HOUR);
      const windowEnd = tenantDayBounds(localDate(now, tz), tz).end;
      // updated_at is also read as text: a JS Date cannot hold its microseconds, and the swap
      // needs exact equality.
      const rows = await tx
        .select({ ...getTableColumns(meetings), updatedAtText: sql<string>`${meetings.updatedAt}::text` })
        .from(meetings)
        .where(
          and(
            eq(meetings.tenantId, tenantId),
            ne(meetings.status, 'cancelled'),
            gte(meetings.startAt, windowStart),
            lt(meetings.startAt, windowEnd),
          ),
        );
      const managerOf = new Map<string, string>();
      const nameOf = new Map<string, string>();
      if (rows.length === 0) return { tz, settings, rows, withOutcome: new Set<string>(), managerOf, nameOf };

      const ids = rows.map((r) => r.id);
      const outcomes = await tx
        .select({ meetingId: meetingOutcomes.meetingId })
        .from(meetingOutcomes)
        .where(and(eq(meetingOutcomes.tenantId, tenantId), inArray(meetingOutcomes.meetingId, ids)));
      const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
      const links = await tx
        .select({ userId: memberships.userId, reportsTo: memberships.reportsToUserId })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.userId, ownerIds)));
      const people = await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds));
      for (const l of links) if (l.reportsTo) managerOf.set(l.userId, l.reportsTo);
      for (const p of people) nameOf.set(p.id, [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email);
      return { tz, settings, rows, withOutcome: new Set(outcomes.map((o) => o.meetingId)), managerOf, nameOf };
    });
    if (!snap) return result;
    const { tz, settings, rows, withOutcome, managerOf, nameOf } = snap;
    result.scanned = rows.length;
    if (rows.length === 0) return result;

    // Phase 2: compute (no transaction open here).
    const input: RiskMeeting[] = rows.map((m) => ({
      id: m.id,
      ownerId: m.ownerId,
      type: m.type,
      status: m.status,
      startAt: m.startAt,
      endAt: m.endAt,
      site: m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : null,
      checkedOutAt: m.checkedOutAt,
      hasOutcome: withOutcome.has(m.id),
    }));
    // Pair meetings only within one tenant-local day.
    const byDay = new Map<string, RiskMeeting[]>();
    for (const m of input) {
      const d = localDate(m.startAt, tz);
      const list = byDay.get(d);
      if (list) list.push(m);
      else byDay.set(d, [m]);
    }
    const drive = (a: LatLng, b: LatLng, departAt: Date) =>
      tenantTransaction((tx) => driveMinutesCached(tx, tenantId, a, b, departAt, maps, { now: () => now }));
    const risks = new Map<string, MeetingRisk>();
    for (const group of byDay.values()) {
      const part = await computeRisks(
        group,
        now,
        { graceMin: settings.graceMin, momDueHours: settings.momDueHours },
        drive,
        // Frozen once the later meeting has started: no re-pricing of past pairs.
        { skipDrive: (next) => next.startAt.getTime() <= now.getTime() },
      );
      for (const [id, r] of part) risks.set(id, r);
    }

    await deps.afterCompute?.();

    type Change = { m: (typeof rows)[number]; next: RiskReason[]; added: RiskReason[]; removed: RiskReason[] };
    const changes: Change[] = [];
    for (const m of rows) {
      let next = risks.get(m.id)?.reasons ?? [];
      // Keep a stored travel_gap on a started meeting (its pair was not re-evaluated).
      if (m.startAt.getTime() <= now.getTime() && m.atRiskReasons.includes('travel_gap') && !next.includes('travel_gap')) {
        const keep = next;
        next = REASON_ORDER.filter((r) => r === 'travel_gap' || keep.includes(r));
      }
      const { added, removed } = diffReasons(m.atRiskReasons, next);
      if (added.length > 0 || removed.length > 0) changes.push({ m, next, added, removed });
    }
    if (changes.length === 0) return result;

    // Phase 3: compare-and-swap writes + notifications in one short tx.
    await tenantTransaction(async (tx) => {
      for (const { m, next, added, removed } of changes) {
        const prevArr =
          m.atRiskReasons.length === 0
            ? sql`'{}'::text[]`
            : sql`ARRAY[${sql.join(
                m.atRiskReasons.map((r) => sql`${r}`),
                sql`, `,
              )}]::text[]`;
        const swapped = await tx
          .update(meetings)
          .set({ atRiskReasons: next })
          .where(
            and(
              eq(meetings.id, m.id),
              eq(meetings.tenantId, tenantId),
              eq(meetings.status, m.status),
              eq(meetings.startAt, m.startAt),
              eq(meetings.endAt, m.endAt),
              sql`${meetings.updatedAt}::text = ${m.updatedAtText}`,
              sql`${meetings.atRiskReasons} = ${prevArr}`,
            ),
          )
          .returning({ id: meetings.id });
        if (swapped.length === 0) continue;
        result.added += added.length;
        result.cleared += removed.length;
        const manager = managerOf.get(m.ownerId);
        const recipients = manager && manager !== m.ownerId ? [m.ownerId, manager] : [m.ownerId];
        const subtitle = `${nameOf.get(m.ownerId) ?? m.ownerId} · ${localHm(m.startAt, tz)}`;
        for (const reason of added) {
          for (const recipientUserId of recipients) {
            await recordNotification(tx, {
              tenantId,
              recipientUserId,
              actorUserId: null,
              type: 'field_meeting_at_risk',
              title: `${TITLE[reason]}: ${m.title}`,
              subtitle,
              entityType: 'meeting',
              entityId: m.id,
              metadata: { reason },
            });
            result.notified++;
          }
        }
        await publishMeetingUpdated(tx, { tenantId, id: m.id, ownerId: m.ownerId });
      }
    });
    return result;
  });
}
