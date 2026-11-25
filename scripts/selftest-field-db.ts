import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold real keys: nothing here may reach Google or Claude.
process.env.MAPS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

/**
 * DB-backed self-test for Field Meetings maps caches + settings. Throwaway tenants.
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-field-db.ts
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('127.0.0.1:15434')) throw new Error('refusing to run: DATABASE_URL is not the test DB');

  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { geocodeCached, driveMinutesCached, normalizeAddress } = await import('../src/lib/field/maps/cached');
  const { getMapsProvider } = await import('../src/lib/field/maps');
  const { getFieldSettings, saveFieldSettings, isWithinTrackingHours } = await import('../src/lib/field/settings');
  const { FieldError } = await import('../src/lib/field/types');
  type MapsProvider = import('../src/lib/field/maps/types').MapsProvider;

  const stamp = Date.now();
  const mk = async (n: string) =>
    ((await db.execute(
      sql`INSERT INTO tenants (name, slug) VALUES (${'ZZ FIELD ' + n}, ${`zz-field-${n}-${stamp}`}) RETURNING id`,
    )) as unknown as Array<{ id: string }>)[0]!.id;
  const A = await mk('a');
  const B = await mk('b');
  const inT = <T,>(t: string, fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
    runWithSystemContext(t, () => tenantTransaction(fn as never)) as Promise<T>;

  type Counting = MapsProvider & { geo: number; drive: number };
  const counting = (over: Partial<MapsProvider> = {}): Counting => {
    const m: Counting = {
      name: 'fake',
      geo: 0,
      drive: 0,
      async geocode() {
        m.geo++;
        return { status: 'ok', point: { lat: 28.5, lng: 77.3 } };
      },
      async reverseGeocode() {
        return 'x';
      },
      async driveMinutes() {
        m.drive++;
        return { minutes: 10 + m.drive, estimate: false };
      },
      async resolveShortUrl() {
        return null;
      },
    };
    return Object.assign(m, over);
  };

  try {
    check('getMapsProvider without key is estimate', getMapsProvider().name === 'estimate');
    check(
      'normalizeAddress collapses case/space/punctuation',
      normalizeAddress('  Sector-62,  NOIDA!! ') === 'sector 62 noida',
      normalizeAddress('  Sector-62,  NOIDA!! '),
    );

    // geocode cache
    const g = counting();
    const r1 = await inT(A, (tx) => geocodeCached(tx, A, 'Sector 62, Noida', g));
    const r2 = await inT(A, (tx) => geocodeCached(tx, A, '  sector 62 NOIDA ', g));
    check(
      'geocodeCached hits provider once for same normalized address',
      g.geo === 1 && r1.status === 'ok' && r2.point?.lat === 28.5,
      { geo: g.geo, r1, r2 },
    );
    await inT(B, (tx) => geocodeCached(tx, B, 'Sector 62, Noida', g));
    check('geocode cache is tenant scoped', g.geo === 2, g.geo);

    const pending = counting({ geocode: async () => (pending.geo++, { status: 'pending' as const }) });
    await inT(A, (tx) => geocodeCached(tx, A, 'Pending Rd', pending));
    await inT(A, (tx) => geocodeCached(tx, A, 'Pending Rd', pending));
    check('pending geocode is not cached', pending.geo === 2, pending.geo);

    const failing = counting({ geocode: async () => (failing.geo++, { status: 'failed' as const }) });
    await inT(A, (tx) => geocodeCached(tx, A, 'Nowhere Lane', failing));
    const rf = await inT(A, (tx) => geocodeCached(tx, A, 'Nowhere Lane', failing));
    check('failed geocode is cached', failing.geo === 1 && rf.status === 'failed', { geo: failing.geo, rf });

    // drive cache
    const d = counting();
    const a = { lat: 28.57081, lng: 77.32611 };
    const b = { lat: 28.495, lng: 77.0895 };
    const t0 = new Date('2026-12-01T10:07:00Z');
    const at = (min: number) => ({ now: () => new Date(t0.getTime() + min * 60_000) });
    const d1 = await inT(A, (tx) => driveMinutesCached(tx, A, a, b, t0, d, at(0)));
    const d2 = await inT(A, (tx) =>
      driveMinutesCached(tx, A, { lat: 28.57084, lng: 77.32612 }, b, new Date('2026-12-01T10:20:00Z'), d, at(20)),
    );
    check('drive cache reused within 30 min (4dp key, 30 min bucket)', d.drive === 1 && d2.minutes === d1.minutes, {
      drive: d.drive,
      d1,
      d2,
    });
    const d3 = await inT(A, (tx) => driveMinutesCached(tx, A, a, b, t0, d, at(31)));
    check('drive cache refetched after 30 min', d.drive === 2 && d3.minutes === 12, { drive: d.drive, d3 });
    const d4 = await inT(A, (tx) => driveMinutesCached(tx, A, a, b, t0, d, at(32)));
    check('refetch overwrote the row', d.drive === 2 && d4.minutes === 12, { drive: d.drive, d4 });
    const est = counting({ driveMinutes: async () => ({ minutes: 5, estimate: true }) });
    await inT(A, (tx) => driveMinutesCached(tx, A, b, a, t0, est, at(0)));
    const rows = await inT(A, (tx) => tx.select().from(s.driveTimeCache));
    check('estimates are not cached', rows.length === 1, rows.length);

    // settings
    const def = await inT(A, (tx) => getFieldSettings(tx, A));
    check(
      'settings defaults without row',
      def.checkinRadiusM === 300 &&
        def.graceMin === 15 &&
        def.momDueHours === 2 &&
        def.trackingStart === '09:00' &&
        def.trackingEnd === '19:00' &&
        def.locationProvider === 'none',
      def,
    );
    const rejects = async (patch: Parameters<typeof saveFieldSettings>[2]) => {
      try {
        await inT(A, (tx) => saveFieldSettings(tx, A, patch));
        return false;
      } catch (e) {
        return e instanceof FieldError && e.code === 'validation';
      }
    };
    check('saveFieldSettings rejects radius 10', await rejects({ checkinRadiusM: 10 }));
    check('saveFieldSettings rejects radius 5001', await rejects({ checkinRadiusM: 5001 }));
    check('saveFieldSettings rejects grace 121', await rejects({ graceMin: 121 }));
    check(
      'saveFieldSettings rejects momDue 0 and 73',
      (await rejects({ momDueHours: 0 })) && (await rejects({ momDueHours: 73 })),
    );
    check('saveFieldSettings rejects bad HH:MM', await rejects({ trackingStart: '9am' }));
    check('saveFieldSettings rejects start >= end', await rejects({ trackingStart: '19:00', trackingEnd: '09:00' }));
    const saved = await inT(A, (tx) => saveFieldSettings(tx, A, { checkinRadiusM: 500, trackingEnd: '18:30' }));
    const back = await inT(A, (tx) => getFieldSettings(tx, A));
    check(
      'saveFieldSettings persists partial patch',
      saved.checkinRadiusM === 500 && back.checkinRadiusM === 500 && back.trackingEnd === '18:30' && back.graceMin === 15,
      back,
    );
    check('patch start validated against stored end', await rejects({ trackingStart: '18:30' }));
    const other = await inT(B, (tx) => getFieldSettings(tx, B));
    check('settings tenant scoped', other.checkinRadiusM === 300, other);

    // tracking hours (IST = UTC+5:30)
    const st = { ...def, trackingStart: '09:00', trackingEnd: '19:00' };
    const ist = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00+05:30`);
    check('isWithinTrackingHours 08:59 IST false', !isWithinTrackingHours(st, ist('08:59'), 'Asia/Kolkata'));
    check('isWithinTrackingHours 09:00 IST true', isWithinTrackingHours(st, ist('09:00'), 'Asia/Kolkata'));
    check('isWithinTrackingHours 18:59 IST true', isWithinTrackingHours(st, ist('18:59'), 'Asia/Kolkata'));
    check('isWithinTrackingHours 19:00 IST false', !isWithinTrackingHours(st, ist('19:00'), 'Asia/Kolkata'));
    check('isWithinTrackingHours 00:30 IST false', !isWithinTrackingHours(st, ist('00:30'), 'Asia/Kolkata'));
    check('isWithinTrackingHours honors tz (same instant, UTC)', !isWithinTrackingHours(st, ist('09:00'), 'UTC'));

    await meetingServiceTests();
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    // Tenant delete cascades meetings/memberships/deals; meetings.owner_id has no
    // ON DELETE, so users go last.
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
    await db.execute(sql`DELETE FROM users WHERE id LIKE ${`zz_field_%_${stamp}`}`);
  }

  // ---------------------------------------------------------------- meeting service (Task 4)
  async function meetingServiceTests() {
    const M = await import('../src/lib/field/meetings');
    const CI = await import('../src/lib/field/checkins');
    const OC = await import('../src/lib/field/outcomes');
    const DY = await import('../src/lib/field/day');
    type FieldActor = import('../src/lib/field/types').FieldActor;

    const uid = (n: string) => `zz_field_${n}_${stamp}`;
    const U = { o: uid('o'), m: uid('m'), r1: uid('r1'), r2: uid('r2'), r3: uid('r3'), b1: uid('b1') };
    await db.insert(s.users).values(
      Object.entries(U).map(([k, id]) => ({ id, email: `${id}@example.test`, firstName: k.toUpperCase(), lastName: 'Zz' })),
    );
    await db.insert(s.memberships).values([
      { tenantId: A, userId: U.o, role: 'owner' as const },
      { tenantId: A, userId: U.m, role: 'manager' as const },
      { tenantId: A, userId: U.r1, role: 'member' as const, reportsToUserId: U.m },
      { tenantId: A, userId: U.r2, role: 'member' as const, reportsToUserId: U.m },
      { tenantId: A, userId: U.r3, role: 'member' as const },
      { tenantId: B, userId: U.b1, role: 'member' as const },
    ]);
    const act = (tenantId: string, userId: string, role: FieldActor['role']): FieldActor => ({ tenantId, userId, role });
    const o = act(A, U.o, 'owner');
    const m = act(A, U.m, 'manager');
    const r1 = act(A, U.r1, 'member');
    const r2 = act(A, U.r2, 'member');
    const r3 = act(A, U.r3, 'member');
    const b1 = act(B, U.b1, 'member');

    // The settings tests above left tenant A at 500 m; the brief's cases assume the 300 m default.
    await inT(A, (tx) => saveFieldSettings(tx, A, { checkinRadiusM: 300 }));
    const S = { lat: 28.5355, lng: 77.391 };
    const north = (meters: number) => ({ lat: S.lat + meters / 111_195, lng: S.lng });
    const [siteCo] = await db
      .insert(s.companies)
      .values({ tenantId: A, name: 'ZZ Site Co', address: 'Site Rd, Noida', lat: S.lat, lng: S.lng, geocodeStatus: 'ok' })
      .returning();
    const [bigCo] = await db
      .insert(s.companies)
      .values({ tenantId: A, name: 'ZZ Big Plant', address: 'Plant Rd', lat: S.lat, lng: S.lng, geocodeStatus: 'ok' })
      .returning();
    const [deal1] = await db
      .insert(s.deals)
      .values({ tenantId: A, name: 'ZZ Deal 1', amountMinor: 1_000_000, currency: 'INR', companyId: siteCo!.id, ownerId: U.r1 })
      .returning();
    const [dealK] = await db
      .insert(s.deals)
      .values({ tenantId: A, name: 'ZZ Deal K', amountMinor: 500_000, currency: 'INR', ownerId: U.r3 })
      .returning();

    const fixedNow = new Date('2026-12-02T05:00:00Z'); // 10:30 IST
    const geoTable: Record<string, { lat: number; lng: number }> = {
      'Geo Rd': { lat: 28.6, lng: 77.1 },
      'Other Rd': { lat: 28.7, lng: 77.2 },
    };
    const fake = (over: Partial<MapsProvider> = {}): MapsProvider => ({
      name: 'fake',
      async geocode(address) {
        const p = geoTable[address];
        return p ? { status: 'ok', point: p } : { status: 'failed' };
      },
      async reverseGeocode() {
        return 'Walk-in address';
      },
      async driveMinutes() {
        return { minutes: 20, estimate: true };
      },
      async resolveShortUrl() {
        return 'https://www.google.com/maps/@28.61,77.21,15z';
      },
      ...over,
    });
    const deps = { maps: fake(), now: () => fixedNow };
    const hours = (h: number) => new Date(fixedNow.getTime() + h * 3_600_000);
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return e instanceof FieldError ? e.code : `other:${String(e)}`;
      }
    };
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return e instanceof FieldError ? e : null;
      }
    };
    let slot = 0;
    const mk = (actor: FieldActor, extra: Partial<Parameters<typeof M.createMeeting>[1]> = {}) => {
      slot++;
      return M.createMeeting(
        actor,
        { title: `ZZ m${slot}`, type: 'physical', startAt: hours(slot), endAt: hours(slot + 0.5), ...extra },
        deps,
      );
    };
    const checkinsOf = (id: string) =>
      inT(A, (tx) => tx.select().from(s.meetingCheckins).where(sql`${s.meetingCheckins.meetingId} = ${id}`));
    const meetingRow = async (id: string) =>
      (await inT(A, (tx) => tx.select().from(s.meetings).where(sql`${s.meetings.id} = ${id}`)))[0]!;

    // --- check-in acceptance
    const m1 = await mk(r1, { companyId: siteCo!.id });
    check('create copies company address + coords', m1.lat === S.lat && m1.address === 'Site Rd, Noida' && m1.geocodeStatus === 'ok', m1);
    const rej = await err(CI.checkIn(r1, m1.id, { ...north(500), accuracyM: 10 }, deps));
    const dist = Number(rej?.details?.distanceM);
    check(
      'acceptance: 500 m reject then override (reject)',
      rej?.code === 'outside_radius' && dist >= 480 && dist <= 520 && rej?.details?.radiusM === 300,
      { code: rej?.code, details: rej?.details },
    );
    const ov = await CI.checkIn(r1, m1.id, { ...north(500), accuracyM: 10, overrideReason: 'gate closed' }, deps);
    const rows1 = (await checkinsOf(m1.id)).sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    check(
      'acceptance: 500 m reject then override (override)',
      ov.verified === false &&
        ov.checkin.overrideReason === 'gate closed' &&
        rows1.length === 2 &&
        rows1.filter((r) => !r.accepted).length === 1 &&
        rows1.filter((r) => r.accepted).length === 1 &&
        (await meetingRow(m1.id)).status === 'checked_in',
      { ov, rows: rows1.map((r) => [r.accepted, r.rejectReason]) },
    );

    const m2 = await mk(r1, { companyId: siteCo!.id });
    const in2 = await CI.checkIn(r1, m2.id, { ...north(50), accuracyM: 10 }, deps);
    check('inside radius verified', in2.verified && in2.distanceM !== null && Math.abs(in2.distanceM - 50) < 3, in2);
    const m3 = await mk(r1, { companyId: siteCo!.id });
    const in3 = await CI.checkIn(r1, m3.id, { ...north(50), accuracyM: 2000 }, deps);
    check('low accuracy inside radius still verified', in3.verified, in3);

    const m4 = await mk(r1);
    const in4 = await CI.checkIn(r1, m4.id, { ...S, accuracyM: 10 }, deps);
    check(
      'no site → unverified site_not_geocoded',
      m4.lat === null && !in4.verified && in4.distanceM === null && in4.checkin.overrideReason === 'site_not_geocoded',
      in4,
    );

    const m5 = await mk(r1, { companyId: siteCo!.id });
    const both = await Promise.allSettled([
      CI.checkIn(r1, m5.id, { ...S, accuracyM: 5 }, deps),
      CI.checkIn(r1, m5.id, { ...S, accuracyM: 5 }, deps),
    ]);
    const rejectedCodes = both.filter((x) => x.status === 'rejected').map((x) => (x.reason as InstanceType<typeof FieldError>).code);
    const acc5 = (await checkinsOf(m5.id)).filter((r) => r.accepted && r.kind === 'in');
    check(
      'concurrent checkin accepts once',
      both.filter((x) => x.status === 'fulfilled').length === 1 &&
        rejectedCodes.length === 1 &&
        rejectedCodes[0] === 'invalid_transition' &&
        acc5.length === 1,
      { rejectedCodes, accepted: acc5.length },
    );

    const m6 = await mk(r1, { companyId: siteCo!.id });
    check('non-owner cannot check in (manager → forbidden)', (await code(CI.checkIn(m, m6.id, { ...S, accuracyM: 5 }, deps))) === 'forbidden');
    check('other tenant check-in → not_found', (await code(CI.checkIn(b1, m6.id, { ...S, accuracyM: 5 }, deps))) === 'not_found');
    check('peer rep check-in → not_found', (await code(CI.checkIn(r3, m6.id, { ...S, accuracyM: 5 }, deps))) === 'not_found');
    check('bad position → validation', (await code(CI.checkIn(r1, m6.id, { lat: 99, lng: 0, accuracyM: 5 }, deps))) === 'validation');

    // --- en route / cancel
    await M.markEnRoute(r1, m6.id, deps);
    const again = await M.markEnRoute(r1, m6.id, deps);
    check('markEnRoute twice is a no-op', again.status === 'en_route', again.status);
    const m6b = await mk(r1);
    const cancelled = await M.cancelMeeting(m, m6b.id, 'client moved', deps);
    check('manager cancels rep meeting', cancelled.status === 'cancelled' && cancelled.cancelReason === 'client moved' && cancelled.cancelledAt !== null, cancelled);
    check('cancel twice → invalid_transition', (await code(M.cancelMeeting(r1, m6b.id, undefined, deps))) === 'invalid_transition');
    check('en-route on cancelled → invalid_transition', (await code(M.markEnRoute(r1, m6b.id, deps))) === 'invalid_transition');

    // --- walk-in
    const countWalkins = async () =>
      (await inT(A, (tx) => tx.select().from(s.meetings).where(sql`${s.meetings.source} = 'walk_in'`))).length;
    const countCheckins = async () => (await inT(A, (tx) => tx.select().from(s.meetingCheckins))).length;
    const [wb, cb] = [await countWalkins(), await countCheckins()];
    const throwing = fake({
      reverseGeocode: async () => {
        throw new Error('reverse geocode down');
      },
    });
    const wErr = await code(CI.walkIn(r1, { ...S, accuracyM: 12 }, { maps: throwing, now: () => fixedNow }));
    check('walk-in atomic (failure leaves nothing)', wErr !== 'ok' && (await countWalkins()) === wb && (await countCheckins()) === cb, {
      wErr,
    });
    const w = await CI.walkIn(r1, { ...S, accuracyM: 12 }, deps);
    const wRows = await checkinsOf(w.id);
    check(
      'walk-in atomic (success)',
      w.source === 'walk_in' &&
        w.status === 'checked_in' &&
        w.needsLinking === true &&
        w.geocodeStatus === 'manual' &&
        w.address === 'Walk-in address' &&
        w.endAt.getTime() - w.startAt.getTime() === 30 * 60_000 &&
        wRows.length === 1 &&
        wRows[0]!.verified &&
        wRows[0]!.accepted &&
        wRows[0]!.distanceFromSiteM === 0,
      { w, wRows },
    );

    // --- checkout
    const m7 = await mk(r1, { companyId: siteCo!.id, dealId: deal1!.id });
    await CI.checkIn(r1, m7.id, { ...S, accuracyM: 5 }, deps);
    await CI.checkOut(r1, m7.id, { ...S, accuracyM: 5 }, deps);
    const secondOut = await code(CI.checkOut(r1, m7.id, { ...S, accuracyM: 5 }, deps));
    const logs = await inT(A, (tx) =>
      tx
        .select()
        .from(s.activityLogs)
        .where(sql`${s.activityLogs.entityId} = ${deal1!.id} AND ${s.activityLogs.action} = 'meeting_logged' AND ${s.activityLogs.metadata}->>'meetingId' = ${m7.id}`),
    );
    const m7row = await meetingRow(m7.id);
    check(
      'checkout logs meeting_logged once',
      secondOut === 'invalid_transition' &&
        logs.length === 1 &&
        (logs[0]!.metadata as { verified?: boolean }).verified === true &&
        m7row.status === 'checked_out' &&
        m7row.checkedOutAt !== null,
      { secondOut, logs: logs.map((l) => l.metadata), status: m7row.status },
    );

    // --- outcomes
    const m8 = await mk(r1, { companyId: siteCo!.id });
    await CI.checkIn(r1, m8.id, { ...S, accuracyM: 5 }, deps);
    await inT(A, (tx) => tx.execute(sql`UPDATE meetings SET at_risk_reasons = '{mom_missing,overlap}' WHERE id = ${m8.id}`));
    const noCo = await code(OC.saveOutcome(r1, m8.id, { momText: 'talked' }, deps));
    const out8 = await OC.saveOutcome(
      r1,
      m8.id,
      { momText: 'Discussed pricing', sentiment: 'positive', nextSteps: [{ action: 'Send quote', dueDate: '2026-12-04' }], checkOutAt: { ...S, accuracyM: 5 } },
      deps,
    );
    const m8row = await meetingRow(m8.id);
    check(
      'outcome on checked_in with checkOutAt → mom_logged and clears mom_missing',
      noCo === 'invalid_transition' &&
        out8.momText === 'Discussed pricing' &&
        out8.nextSteps.length === 1 &&
        m8row.status === 'mom_logged' &&
        m8row.checkedOutAt !== null &&
        JSON.stringify(m8row.atRiskReasons) === '["overlap"]',
      { noCo, out8, status: m8row.status, reasons: m8row.atRiskReasons },
    );
    const out8b = await OC.saveOutcome(r1, m8.id, { momText: 'Edited MOM' }, deps);
    const outRows = await inT(A, (tx) => tx.select().from(s.meetingOutcomes).where(sql`${s.meetingOutcomes.meetingId} = ${m8.id}`));
    check('editing outcome replaces it', out8b.momText === 'Edited MOM' && outRows.length === 1, outRows.length);
    const m9 = await mk(r1);
    check('outcome on planned physical → invalid_transition', (await code(OC.saveOutcome(r1, m9.id, { momText: 'x' }, deps))) === 'invalid_transition');
    const m10 = await mk(r1, { type: 'virtual', virtualUrl: 'https://meet.example/abc' });
    await OC.saveOutcome(r1, m10.id, { momText: 'virtual call notes' }, deps);
    check('virtual planned → mom_logged', (await meetingRow(m10.id)).status === 'mom_logged');
    check('empty MOM → validation', (await code(OC.saveOutcome(r1, m9.id, { momText: '  ' }, deps))) === 'validation');

    // --- scoping (own day: 2026-12-03 IST)
    const day3 = (h: number) => new Date(`2026-12-03T${String(h).padStart(2, '0')}:00:00+05:30`);
    const onDay3 = (actor: FieldActor, h: number, ownerId?: string) =>
      M.createMeeting(actor, { title: `ZZ d3 ${h}`, type: 'physical', startAt: day3(h), endAt: day3(h + 1), ownerId }, deps);
    await onDay3(r1, 9);
    await onDay3(m, 10, U.r1); // manager creating for r1
    await onDay3(m, 11, U.r2);
    await onDay3(r3, 12);
    await onDay3(m, 13);
    await onDay3(o, 14);
    const repIds = (v: Awaited<ReturnType<typeof DY.getDay>>) => v.reps.map((r) => r.userId).sort();
    const vR1 = await DY.getDay(r1, { date: '2026-12-03' }, deps);
    const vM = await DY.getDay(m, { date: '2026-12-03' }, deps);
    const vO = await DY.getDay(o, { date: '2026-12-03' }, deps);
    const vB = await DY.getDay(b1, { date: '2026-12-03' }, deps);
    check('scoping: r1 sees only own', JSON.stringify(repIds(vR1)) === JSON.stringify([U.r1]) && vR1.reps[0]!.meetings.length === 2, repIds(vR1));
    check(
      'scoping: m sees r1+r2+self, not r3',
      JSON.stringify(repIds(vM)) === JSON.stringify([U.m, U.r1, U.r2].sort()) && vM.scopeFallback === false,
      repIds(vM),
    );
    check('scoping: o sees all', [U.o, U.m, U.r1, U.r2, U.r3].every((id) => repIds(vO).includes(id)), repIds(vO));
    check('scoping: r1 create for r2 → forbidden', (await code(onDay3(r1, 15, U.r2))) === 'forbidden');
    check('scoping: m create for r3 (outside scope) → forbidden', (await code(onDay3(m, 15, U.r3))) === 'forbidden');
    check('scoping: tenant B sees no tenant A rows', vB.reps.length === 0 && vB.kpis.planned === 0, vB.reps.length);
    check('scoping: tenant B cannot edit tenant A meeting', (await code(M.updateMeeting(b1, m1.id, { title: 'hack' }, deps))) === 'not_found');
    const vMr1 = await DY.getDay(m, { date: '2026-12-03', repId: U.r1 }, deps);
    check('scoping: repId narrows within scope', JSON.stringify(repIds(vMr1)) === JSON.stringify([U.r1]), repIds(vMr1));
    const vMr3 = await DY.getDay(m, { date: '2026-12-03', repId: U.r3 }, deps);
    check('scoping: repId outside scope → empty', vMr3.reps.length === 0, repIds(vMr3));

    // --- pins
    const mp = await mk(r1, { address: 'Geo Rd' });
    check('create geocodes a given address', mp.geocodeStatus === 'ok' && mp.lat === 28.6, mp);
    const mpEdit = await M.updateMeeting(r1, mp.id, { address: 'Other Rd' }, deps);
    check('address edit re-geocodes non-manual site', mpEdit.lat === 28.7 && mpEdit.address === 'Other Rd', mpEdit);
    check('rep cannot pin', (await code(M.pinMeetingSite(r1, mp.id, '28.61, 77.21', deps))) === 'forbidden');
    check('rep cannot pin company', (await code(M.pinCompanySite(r1, bigCo!.id, '28.61, 77.21', 800, deps))) === 'forbidden');
    const pinned = await M.pinMeetingSite(m, mp.id, 'https://maps.app.goo.gl/abc123', deps);
    check('manager pins via link → manual', pinned.geocodeStatus === 'manual' && pinned.lat === 28.61 && pinned.lng === 77.21, pinned);
    const kept = await M.updateMeeting(m, mp.id, { address: 'Geo Rd' }, deps);
    check('address edit keeps manual pin', kept.geocodeStatus === 'manual' && kept.lat === 28.61 && kept.address === 'Geo Rd', kept);
    check('garbage pin → validation', (await code(M.pinMeetingSite(m, mp.id, 'not a place', deps))) === 'validation');
    const co = await M.pinCompanySite(m, bigCo!.id, `${S.lat}, ${S.lng}`, 800, deps);
    check('pinCompanySite sets manual + radius', co.geocodeStatus === 'manual' && co.checkinRadiusM === 800, co);
    const mBig = await mk(r1, { companyId: bigCo!.id });
    const inBig = await CI.checkIn(r1, mBig.id, { ...north(500), accuracyM: 10 }, deps);
    check('company radius 800 overrides tenant 300', inBig.verified, inBig);

    // --- tenant-local day
    const late = await M.createMeeting(
      r2,
      { title: 'ZZ late', type: 'physical', startAt: new Date('2026-11-26T00:30:00+05:30'), endAt: new Date('2026-11-26T01:00:00+05:30') },
      deps,
    );
    const v26 = await DY.getDay(r2, { date: '2026-11-26' }, deps);
    const v25 = await DY.getDay(r2, { date: '2026-11-25' }, deps);
    const has = (v: typeof v26) => v.reps.some((r) => r.meetings.some((x) => x.id === late.id));
    check('day view uses tenant-local day', has(v26) && !has(v25) && v26.tz === 'Asia/Kolkata', { in26: has(v26), in25: has(v25), tz: v26.tz });
    check('malformed date → validation', (await code(DY.getDay(r2, { date: '2026-13-01' }, deps))) === 'validation');

    // --- KPI distinct deal (2026-12-05 IST)
    const day5 = (h: number) => new Date(`2026-12-05T${String(h).padStart(2, '0')}:00:00+05:30`);
    for (const h of [9, 11, 13]) {
      await M.createMeeting(r3, { title: `ZZ k${h}`, type: 'physical', startAt: day5(h), endAt: day5(h + 1), dealId: dealK!.id }, deps);
    }
    const vK = await DY.getDay(r3, { date: '2026-12-05' }, deps);
    const km = vK.reps[0]?.meetings ?? [];
    check(
      'acceptance: KPI distinct deal',
      vK.kpis.pipelineMinor === 500_000 && vK.kpis.planned === 3 && km.length === 3 && km[0]!.deal?.name === 'ZZ Deal K' && Array.isArray(km[0]!.checkins) && Array.isArray(km[0]!.risk.reasons),
      { kpis: vK.kpis, n: km.length },
    );

    // --- live risk on the board: m6 (en_route, start +6h) is not late at fixedNow; late check
    const lateView = await DY.getDay(r1, { date: '2026-12-02' }, { ...deps, now: () => hours(12) });
    const m6v = lateView.reps.flatMap((r) => r.meetings).find((x) => x.id === m6.id);
    check('day view computes live no_checkin risk', !!m6v && m6v.risk.reasons.includes('no_checkin'), m6v?.risk);
    const riskOnly = await DY.getDay(r1, { date: '2026-12-02', atRiskOnly: true }, { ...deps, now: () => hours(12) });
    check(
      'atRiskOnly filters to at-risk meetings',
      riskOnly.reps.flatMap((r) => r.meetings).every((x) => x.risk.reasons.length > 0) && riskOnly.reps.flatMap((r) => r.meetings).length > 0,
    );
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nfield db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
