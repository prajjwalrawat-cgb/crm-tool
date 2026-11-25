import 'server-only';

import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';

import { db } from '@/db';
import { memberships, meetingOutcomes, meetings, organizationSettings, users } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { recordNotification } from '@/lib/notifications/recorder';

import { tenantDayBounds } from './day';
import { mapsOf, publishMeetingUpdated } from './internal';
import type { FieldDeps } from './internal';
import { driveMinutesCached } from './maps/cached';
import { computeRisks, diffReasons, type RiskMeeting } from './risk';
import { getFieldSettings, isWithinTrackingHours } from './settings';
import type { RiskReason } from './types';

const HOUR = 3_600_000;
const DEFAULT_TZ = 'Asia/Kolkata';

export type RiskScanDeps = FieldDeps & { ignoreHours?: boolean };
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
 * reason. A reason that clears and later returns is a new appearance. Idempotent:
 * a second run with the same inputs writes and notifies nothing.
 */
export async function scanTenantRisks(tenantId: string, deps: RiskScanDeps = {}): Promise<RiskScanResult> {
  const now = (deps.now ?? (() => new Date()))();
  const maps = mapsOf(deps);
  const result: RiskScanResult = { scanned: 0, added: 0, cleared: 0, notified: 0 };

  return runWithSystemContext(tenantId, () =>
    tenantTransaction(async (tx) => {
      // Sequential on purpose: one transaction = one connection; no nested transactions.
      const [org] = await tx
        .select({ timezone: organizationSettings.timezone })
        .from(organizationSettings)
        .where(eq(organizationSettings.tenantId, tenantId))
        .limit(1);
      const tz = validTz(org?.timezone);
      const settings = await getFieldSettings(tx, tenantId);
      if (!deps.ignoreHours && !isWithinTrackingHours(settings, now, tz)) return result;

      const windowStart = new Date(now.getTime() - 48 * HOUR);
      const windowEnd = tenantDayBounds(localDate(now, tz), tz).end;
      // FOR UPDATE serializes overlapping scans on the same rows: the later one re-reads the
      // updated reasons and so cannot notify the same appearance twice.
      const rows = await tx
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.tenantId, tenantId),
            ne(meetings.status, 'cancelled'),
            gte(meetings.startAt, windowStart),
            lt(meetings.startAt, windowEnd),
          ),
        )
        .for('update');
      result.scanned = rows.length;
      if (rows.length === 0) return result;

      const ids = rows.map((r) => r.id);
      const outcomes = await tx
        .select({ meetingId: meetingOutcomes.meetingId })
        .from(meetingOutcomes)
        .where(and(eq(meetingOutcomes.tenantId, tenantId), inArray(meetingOutcomes.meetingId, ids)));
      const withOutcome = new Set(outcomes.map((o) => o.meetingId));

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
      const risks = await computeRisks(
        input,
        now,
        { graceMin: settings.graceMin, momDueHours: settings.momDueHours },
        (a, b, departAt) => driveMinutesCached(tx, tenantId, a, b, departAt, maps, { now: () => now }),
      );

      type Change = { m: (typeof rows)[number]; next: RiskReason[]; added: RiskReason[] };
      const changes: Change[] = [];
      for (const m of rows) {
        const next = risks.get(m.id)?.reasons ?? [];
        const { added, removed } = diffReasons(m.atRiskReasons, next);
        if (added.length === 0 && removed.length === 0) continue;
        result.added += added.length;
        result.cleared += removed.length;
        changes.push({ m, next, added });
      }
      if (changes.length === 0) return result;

      const ownerIds = [...new Set(changes.filter((c) => c.added.length > 0).map((c) => c.m.ownerId))];
      const managerOf = new Map<string, string>();
      const nameOf = new Map<string, string>();
      if (ownerIds.length > 0) {
        const links = await tx
          .select({ userId: memberships.userId, reportsTo: memberships.reportsToUserId })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.userId, ownerIds)));
        for (const l of links) if (l.reportsTo) managerOf.set(l.userId, l.reportsTo);
        const people = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(inArray(users.id, ownerIds));
        for (const p of people) {
          nameOf.set(p.id, [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email);
        }
      }

      for (const { m, next, added } of changes) {
        await tx.update(meetings).set({ atRiskReasons: next }).where(and(eq(meetings.id, m.id), eq(meetings.tenantId, tenantId)));
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
      return result;
    }),
  );
}
