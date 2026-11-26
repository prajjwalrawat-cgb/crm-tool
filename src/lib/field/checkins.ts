import 'server-only';

import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { companies, meetingCheckins, meetings, type Meeting, type MeetingCheckin } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { tenantTransaction } from '@/lib/db-context';

import { checkinWindow, checkinWindowState } from './checkin-window';
import { haversineMeters } from './geo';
import {
  asActor,
  mapsOf,
  nowOf,
  optText,
  publishMeetingUpdated,
  validatePosition,
  type FieldDeps,
  type Position,
  type Tx,
} from './internal';
import { checkLinks } from './meetings';
import { assertCanWrite, fieldUserScope, lockOwnedMeeting } from './scope';
import { getFieldSettings } from './settings';
import { assertTransition } from './state-machine';
import { FieldError, type FieldActor, type LatLng } from './types';

/**
 * Check-in / check-out / walk-in. Every attempt is logged in meeting_checkins,
 * accepted or not. Only the meeting owner can check in or out.
 */

export type CheckResult = { checkin: MeetingCheckin; verified: boolean; distanceM: number | null };
export type WalkInInput = Position & {
  title?: string;
  dealId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  notes?: string | null;
};

const WALK_IN_MINUTES = 30;

const siteOf = (m: Meeting): LatLng | null => (m.lat !== null && m.lng !== null ? { lat: m.lat, lng: m.lng } : null);
const round = (d: number | null) => (d === null ? null : Math.round(d));

/** The meeting's company radius override, else the tenant radius. */
async function effectiveRadius(tx: Tx, tenantId: string, companyId: string | null, tenantRadiusM?: number): Promise<number> {
  if (companyId) {
    const [c] = await tx
      .select({ r: companies.checkinRadiusM })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .limit(1);
    if (c?.r != null) return c.r;
  }
  return tenantRadiusM ?? (await getFieldSettings(tx, tenantId)).checkinRadiusM;
}

const setMeeting = (tx: Tx, m: Meeting, values: { [K in keyof typeof meetings.$inferInsert]?: (typeof meetings.$inferInsert)[K] | SQL }) =>
  tx
    .update(meetings)
    .set(values)
    .where(and(eq(meetings.tenantId, m.tenantId), eq(meetings.id, m.id)))
    .returning();

type CheckInTx =
  | { rejected: 'window'; opensAt: Date; closesAt: Date; state: 'before' | 'after' }
  | { rejected: true; distanceM: number; radiusM: number }
  | { rejected: false; checkin: MeetingCheckin; verified: boolean; distanceM: number | null };

export function checkIn(
  actor: FieldActor,
  id: string,
  pos: Position & { overrideReason?: string },
  deps?: FieldDeps,
): Promise<CheckResult> {
  return asActor(actor, async () => {
    const p = validatePosition(pos);
    const override = optText(pos.overrideReason, 'Override reason', 500);
    const now = nowOf(deps);
    assertCanWrite(actor);
    const scope = await fieldUserScope(actor); // before the tx: no second connection under the lock

    // The row lock serialises double taps: the second caller re-reads
    // `checked_in` and fails assertTransition with invalid_transition.
    const res: CheckInTx = await tenantTransaction(async (tx) => {
      const cur = await lockOwnedMeeting(tx, actor, scope, id);
      assertTransition(cur.status, 'checked_in', cur.type);
      const settings = await getFieldSettings(tx, actor.tenantId);
      const window = checkinWindow(cur, settings);
      const windowState = checkinWindowState(window, now);
      const radiusM = await effectiveRadius(tx, actor.tenantId, cur.companyId, settings.checkinRadiusM);
      const site = siteOf(cur);
      const distanceM = site ? haversineMeters(site, p) : null;
      const base = {
        tenantId: actor.tenantId,
        meetingId: cur.id,
        userId: actor.userId,
        kind: 'in' as const,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        distanceFromSiteM: distanceM,
        locationSource: 'browser' as const,
        capturedAt: now,
      };

      if (windowState !== 'open') {
        // Outside the time window: an override reason does not bypass it.
        await tx.insert(meetingCheckins).values({ ...base, accepted: false, verified: false, rejectReason: 'outside_window' });
        return { rejected: 'window', ...window, state: windowState };
      }

      if (distanceM !== null && distanceM > radiusM && !override) {
        // Commit the rejected attempt; the error is thrown after the transaction.
        await tx.insert(meetingCheckins).values({ ...base, accepted: false, verified: false, rejectReason: 'outside_radius' });
        return { rejected: true, distanceM, radiusM };
      }

      const verified = distanceM !== null && distanceM <= radiusM;
      const overrideReason = distanceM === null ? 'site_not_geocoded' : verified ? null : override;
      const [checkin] = await tx
        .insert(meetingCheckins)
        .values({ ...base, accepted: true, verified, overrideReason })
        .returning();
      const [row] = await setMeeting(tx, cur, {
        status: 'checked_in',
        checkedInAt: now,
        atRiskReasons: sql`array_remove(${meetings.atRiskReasons}, 'no_checkin')`,
        updatedAt: now,
      });
      await publishMeetingUpdated(tx, row!);
      return { rejected: false, checkin: checkin!, verified, distanceM };
    });

    if (res.rejected === 'window') {
      throw new FieldError(
        'outside_window',
        res.state === 'before'
          ? 'Check-in has not opened yet for this meeting'
          : 'Check-in has closed for this meeting',
        { opensAt: res.opensAt, closesAt: res.closesAt },
      );
    }
    if (res.rejected) {
      const d = Math.round(res.distanceM);
      throw new FieldError('outside_radius', `You are ${d} m from the site; check-in needs ${res.radiusM} m or closer`, {
        distanceM: d,
        radiusM: res.radiusM,
      });
    }
    return { checkin: res.checkin, verified: res.verified, distanceM: round(res.distanceM) };
  });
}

/**
 * Check out inside an open transaction on a meeting already locked by the
 * caller. Never rejected. Records `meeting_logged` on the linked deal.
 */
export async function checkOutTx(
  tx: Tx,
  actor: FieldActor,
  cur: Meeting,
  pos: Position,
  now: Date,
): Promise<CheckResult & { meeting: Meeting }> {
  const p = validatePosition(pos);
  assertTransition(cur.status, 'checked_out', cur.type);
  const site = siteOf(cur);
  const distanceM = site ? haversineMeters(site, p) : null;
  const verified = distanceM !== null && distanceM <= (await effectiveRadius(tx, actor.tenantId, cur.companyId));
  const [checkin] = await tx
    .insert(meetingCheckins)
    .values({
      tenantId: actor.tenantId,
      meetingId: cur.id,
      userId: actor.userId,
      kind: 'out',
      lat: p.lat,
      lng: p.lng,
      accuracyM: p.accuracyM,
      distanceFromSiteM: distanceM,
      verified,
      accepted: true,
      locationSource: 'browser',
      capturedAt: now,
    })
    .returning();
  const [row] = await setMeeting(tx, cur, { status: 'checked_out', checkedOutAt: now, updatedAt: now });

  if (cur.dealId) {
    // `verified` on the activity is the check-in's verdict (the visit), not the check-out's.
    const [inRow] = await tx
      .select({ verified: meetingCheckins.verified })
      .from(meetingCheckins)
      .where(
        and(
          eq(meetingCheckins.tenantId, actor.tenantId),
          eq(meetingCheckins.meetingId, cur.id),
          eq(meetingCheckins.kind, 'in'),
          eq(meetingCheckins.accepted, true),
        ),
      )
      .orderBy(desc(meetingCheckins.capturedAt))
      .limit(1);
    await recordActivity(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      entityType: 'deal',
      entityId: cur.dealId,
      action: 'meeting_logged',
      metadata: { meetingId: cur.id, verified: inRow?.verified ?? false },
    });
  }
  await publishMeetingUpdated(tx, row!);
  return { checkin: checkin!, verified, distanceM: round(distanceM), meeting: row! };
}

export function checkOut(actor: FieldActor, id: string, pos: Position, deps?: FieldDeps): Promise<CheckResult> {
  return asActor(actor, async () => {
    const p = validatePosition(pos);
    const now = nowOf(deps);
    assertCanWrite(actor);
    const scope = await fieldUserScope(actor);
    const r = await tenantTransaction(async (tx) =>
      checkOutTx(tx, actor, await lockOwnedMeeting(tx, actor, scope, id), p, now),
    );
    return { checkin: r.checkin, verified: r.verified, distanceM: r.distanceM };
  });
}

/**
 * Unplanned visit: one transaction creates the meeting at the rep's position
 * (reverse geocoded first, so a provider failure leaves nothing behind) and a
 * verified check-in.
 */
export function walkIn(actor: FieldActor, input: WalkInInput, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanWrite(actor);
    const p = validatePosition(input);
    const title = optText(input.title, 'Title', 300) ?? 'Walk-in';
    const notes = optText(input.notes, 'Notes');
    const now = nowOf(deps);
    const maps = mapsOf(deps);

    return tenantTransaction(async (tx) => {
      await checkLinks(tx, actor.tenantId, input);
      const address = await maps.reverseGeocode({ lat: p.lat, lng: p.lng });
      assertTransition('planned', 'checked_in', 'physical');
      const [meeting] = await tx
        .insert(meetings)
        .values({
          tenantId: actor.tenantId,
          ownerId: actor.userId,
          title,
          type: 'physical',
          startAt: now,
          endAt: new Date(now.getTime() + WALK_IN_MINUTES * 60_000),
          dealId: input.dealId ?? null,
          companyId: input.companyId ?? null,
          contactId: input.contactId ?? null,
          address,
          lat: p.lat,
          lng: p.lng,
          geocodeStatus: 'manual',
          siteSource: 'walk_in',
          notes,
          source: 'walk_in',
          status: 'checked_in',
          checkedInAt: now,
          needsLinking: !input.dealId,
          createdBy: actor.userId,
        })
        .returning();
      await tx.insert(meetingCheckins).values({
        tenantId: actor.tenantId,
        meetingId: meeting!.id,
        userId: actor.userId,
        kind: 'in',
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
        distanceFromSiteM: 0,
        verified: true,
        accepted: true,
        overrideReason: null,
        locationSource: 'browser',
        capturedAt: now,
      });
      await publishMeetingUpdated(tx, meeting!);
      return meeting!;
    });
  });
}
