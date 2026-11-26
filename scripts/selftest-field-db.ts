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

  const extraTenants: string[] = [];
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
    await riskScanTests();
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    // Tenant delete cascades meetings/memberships/deals; meetings.owner_id has no
    // ON DELETE, so users go last.
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
    for (const x of extraTenants) await db.execute(sql`DELETE FROM tenants WHERE id = ${x}`);
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
    // The check-in window has its own block below; the rest of these cases check
    // in hours away from meeting time, so open the window as wide as it goes.
    const WIDE = { checkinOpensBeforeMin: 1440, checkinClosesAfterMin: 1440 };
    await inT(A, (tx) => saveFieldSettings(tx, A, WIDE));
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
        // 15-min slots from 11:00 IST keep every base-day meeting on 2026-12-02 IST.
        { title: `ZZ m${slot}`, type: 'physical', startAt: hours(0.25 * slot + 0.25), endAt: hours(0.25 * slot + 0.45), ...extra },
        deps,
      );
    };
    const checkinsOf = (id: string) =>
      inT(A, (tx) => tx.select().from(s.meetingCheckins).where(sql`${s.meetingCheckins.meetingId} = ${id}`));
    const meetingRow = async (id: string) =>
      (await inT(A, (tx) => tx.select().from(s.meetings).where(sql`${s.meetings.id} = ${id}`)))[0]!;

    // --- check-in time window (defaults: opens 120 min before start, closes 240 min after end)
    {
      await inT(A, (tx) => saveFieldSettings(tx, A, { checkinOpensBeforeMin: 120, checkinClosesAfterMin: 240 }));
      const SA = await import('../src/lib/field/settings');
      const wm = await M.createMeeting(
        r1,
        { title: 'ZZ window', type: 'physical', startAt: hours(5), endAt: hours(5.5), companyId: siteCo!.id },
        deps,
      );
      const early = await err(CI.checkIn(r1, wm.id, { ...S, accuracyM: 5 }, deps));
      const rows = await checkinsOf(wm.id);
      check(
        'window: check-in 5 h before start → outside_window with opensAt/closesAt',
        early?.code === 'outside_window' &&
          (early.details?.opensAt as Date).getTime() === hours(3).getTime() &&
          (early.details?.closesAt as Date).getTime() === hours(9.5).getTime(),
        { code: early?.code, details: early?.details },
      );
      check(
        'window: rejected attempt logged once (outside_window, coords kept), status unchanged',
        rows.length === 1 &&
          rows[0]!.accepted === false &&
          rows[0]!.rejectReason === 'outside_window' &&
          rows[0]!.lat === S.lat &&
          rows[0]!.distanceFromSiteM !== null &&
          (await meetingRow(wm.id)).status === 'planned',
        rows,
      );
      const ov = await err(CI.checkIn(r1, wm.id, { ...north(500), accuracyM: 5, overrideReason: 'client asked' }, deps));
      check('window: override reason does not bypass it', ov?.code === 'outside_window' && (await meetingRow(wm.id)).status === 'planned', ov?.code);
      const http = await import('../src/app/api/field/_lib/http');
      const res = http.fieldErrorResponse(early);
      const body = (await res.json()) as Record<string, unknown>;
      check(
        'window: HTTP 422 body carries ISO opensAt/closesAt',
        res.status === 422 && body.code === 'outside_window' && body.opensAt === hours(3).toISOString() && body.closesAt === hours(9.5).toISOString(),
        body,
      );
      const day = await DY.getDay(r1, { date: '2026-12-02' }, deps);
      const dm = day.reps.flatMap((r) => r.meetings).find((x) => x.id === wm.id);
      check(
        'window: day view exposes checkinOpensAt/closesAt',
        dm?.checkinOpensAt === hours(3).toISOString() && dm?.checkinClosesAt === hours(9.5).toISOString(),
        { o: dm?.checkinOpensAt, c: dm?.checkinClosesAt },
      );
      const atOpen = await CI.checkIn(r1, wm.id, { ...S, accuracyM: 5 }, { ...deps, now: () => hours(3) });
      check('window: check-in at the opening instant works as before', atOpen.verified && (await meetingRow(wm.id)).status === 'checked_in');
      // After close: a meeting that ended 5 h ago (closes 4 h after end).
      const late = await M.createMeeting(r1, { title: 'ZZ window late', type: 'physical', startAt: hours(-5.5), endAt: hours(-5), companyId: siteCo!.id }, deps);
      const lateErr = await err(CI.checkIn(r1, late.id, { ...S, accuracyM: 5 }, deps));
      check('window: check-in after close → outside_window', lateErr?.code === 'outside_window', lateErr?.code);
      // Walk-ins are not affected by the window.
      const walk = await CI.walkIn(r1, { ...S, accuracyM: 5, title: 'ZZ window walk-in' }, deps);
      check('window: walk-in unaffected', walk.status === 'checked_in');

      // Per-field permissions on the settings save path.
      const forbidden = async (role: 'manager' | 'member' | 'admin', patch: Parameters<typeof SA.saveFieldSettingsAs>[3]) => {
        try {
          await inT(A, (tx) => SA.saveFieldSettingsAs(tx, A, role, patch));
          return false;
        } catch (e) {
          return e instanceof FieldError && e.code === 'forbidden';
        }
      };
      const mgrSaved = await inT(A, (tx) => SA.saveFieldSettingsAs(tx, A, 'manager', { checkinOpensBeforeMin: 30, checkinClosesAfterMin: 60 }));
      check('settings: manager can save the check-in window', mgrSaved.checkinOpensBeforeMin === 30 && mgrSaved.checkinClosesAfterMin === 60);
      check('settings: manager cannot save the radius', await forbidden('manager', { checkinRadiusM: 800 }));
      check(
        'settings: manager posting window + radius is rejected whole',
        (await forbidden('manager', { checkinOpensBeforeMin: 10, checkinRadiusM: 800 })) &&
          (await inT(A, (tx) => getFieldSettings(tx, A))).checkinOpensBeforeMin === 30 &&
          (await inT(A, (tx) => getFieldSettings(tx, A))).checkinRadiusM === 300,
      );
      check('settings: member cannot save the window', await forbidden('member', { checkinOpensBeforeMin: 10 }));
      check('settings: member cannot save the radius', await forbidden('member', { checkinRadiusM: 800 }));
      const adm = await inT(A, (tx) => SA.saveFieldSettingsAs(tx, A, 'admin', { checkinRadiusM: 300, checkinOpensBeforeMin: 0, checkinClosesAfterMin: 0 }));
      check('settings: admin can save radius and window', adm.checkinRadiusM === 300 && adm.checkinOpensBeforeMin === 0);
      let rangeErr = false;
      try {
        await inT(A, (tx) => SA.saveFieldSettingsAs(tx, A, 'manager', { checkinClosesAfterMin: 1441 }));
      } catch (e) {
        rangeErr = e instanceof FieldError && e.code === 'validation';
      }
      check('settings: window 1441 → validation', rangeErr);

      // 0 / 0: only during the meeting itself.
      const tight = await M.createMeeting(r1, { title: 'ZZ window tight', type: 'physical', startAt: hours(1), endAt: hours(1.5), companyId: siteCo!.id }, deps);
      const tooEarly = await code(CI.checkIn(r1, tight.id, { ...S, accuracyM: 5 }, { ...deps, now: () => new Date(hours(1).getTime() - 60_000) }));
      const during = await code(CI.checkIn(r1, tight.id, { ...S, accuracyM: 5 }, { ...deps, now: () => hours(1.25) }));
      check('window 0/0: a minute early rejected, during the meeting accepted', tooEarly === 'outside_window' && during === 'ok', { tooEarly, during });

      await inT(A, (tx) => saveFieldSettings(tx, A, WIDE));
    }

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
    check('a rejected check-in leaves status planned', (await meetingRow(m1.id)).status === 'planned');
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

    // --- edit gates once the visit has started (m2 is checked_in)
    check('type flip on checked_in → invalid_transition', (await code(M.updateMeeting(r1, m2.id, { type: 'virtual' }, deps))) === 'invalid_transition');
    check('owner change on checked_in → invalid_transition', (await code(M.updateMeeting(m, m2.id, { ownerId: U.r2 }, deps))) === 'invalid_transition');
    check(
      'time change on checked_in → invalid_transition',
      (await code(M.updateMeeting(r1, m2.id, { endAt: hours(20) }, deps))) === 'invalid_transition',
    );
    const renamed = await M.updateMeeting(r1, m2.id, { title: 'Renamed visit', type: 'physical', notes: 'n1' }, deps);
    check('title/notes edit on checked_in ok (unchanged type resent)', renamed.title === 'Renamed visit' && renamed.notes === 'n1', renamed);
    check('pin on checked_in → invalid_transition', (await code(M.pinMeetingSite(m, m2.id, '28.61, 77.21', deps))) === 'invalid_transition');

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
    check('mom_logged: title edit → invalid_transition', (await code(M.updateMeeting(r1, m8.id, { title: 'x2' }, deps))) === 'invalid_transition');
    check('mom_logged: notes edit ok', (await M.updateMeeting(r1, m8.id, { notes: 'after MOM' }, deps)).notes === 'after MOM');
    check('pin virtual → validation', (await code(M.pinMeetingSite(m, m10.id, '28.61, 77.21', deps))) === 'validation');
    check('owner change to out-of-scope user on planned → forbidden', (await code(M.updateMeeting(m, m9.id, { ownerId: U.r3 }, deps))) === 'forbidden');
    const moved = await M.updateMeeting(m, m9.id, { ownerId: U.r2 }, deps);
    check('owner change in scope on planned ok', moved.ownerId === U.r2, moved.ownerId);
    const geoThrows = fake({
      geocode: async () => {
        throw new Error('geocoder down');
      },
    });
    const gf = await M.createMeeting(r1, { title: 'ZZ geo fail', type: 'physical', startAt: hours(10), endAt: hours(10.1), address: 'Somewhere 1' }, { maps: geoThrows, now: () => fixedNow });
    check('geocoder throw never blocks saving (failed)', gf.geocodeStatus === 'failed' && gf.lat === null, gf.geocodeStatus);

    // --- pool: 12 concurrent manager edits (pool max 10) must not hang
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(r1, { title: `ZZ pool ${i}` })));
    const race = await Promise.race([
      Promise.allSettled(many.map((x, i) => M.updateMeeting(m, x.id, { title: `ZZ pool edited ${i}` }, deps))).then((r) => r),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 20_000)),
    ]);
    check(
      '12 concurrent manager edits complete (no pool deadlock)',
      race !== 'timeout' && race.every((x) => x.status === 'fulfilled'),
      race === 'timeout' ? 'timeout' : race.filter((x) => x.status === 'rejected').map((x) => String((x as PromiseRejectedResult).reason)),
    );
    const cancels = await Promise.race([
      Promise.allSettled(many.map((x) => M.cancelMeeting(m, x.id, 'pool', deps))),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 20_000)),
    ]);
    check('12 concurrent manager cancels complete', cancels !== 'timeout' && cancels.every((x) => x.status === 'fulfilled'));

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
    // Company pin propagates to not-started meetings without their own manual pin.
    const [pCo] = await db.insert(s.companies).values({ tenantId: A, name: 'ZZ Pending Co' }).returning();
    const pa = await mk(r1, { companyId: pCo!.id });
    const pb = await mk(r1, { companyId: pCo!.id });
    await M.pinMeetingSite(m, pb.id, '28.61, 77.21', deps);
    const pc = await mk(r1, { companyId: pCo!.id });
    await CI.checkIn(r1, pc.id, { ...S, accuracyM: 5 }, deps);
    await M.pinCompanySite(m, pCo!.id, '28.55, 77.25', undefined, deps);
    const [ra, rb, rc] = [await meetingRow(pa.id), await meetingRow(pb.id), await meetingRow(pc.id)];
    check(
      'company pin moves only not-started, non-manual meetings',
      pa.geocodeStatus === 'pending' &&
        ra.lat === 28.55 &&
        ra.geocodeStatus === 'manual' &&
        rb.lat === 28.61 &&
        rc.lat === null &&
        rc.status === 'checked_in',
      { a: [ra.lat, ra.geocodeStatus], b: rb.lat, c: [rc.lat, rc.status] },
    );

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

    // --- getDay drive lookups: no provider call with a transaction open, cache reused, past pairs frozen
    {
      let openTx = 0;
      let calls = 0;
      let callsInTx = 0;
      const realTx = db.transaction.bind(db);
      const patched = ((fn: Parameters<typeof db.transaction>[0], cfg?: Parameters<typeof db.transaction>[1]) =>
        realTx(async (tx) => {
          openTx++;
          try {
            return await fn(tx);
          } finally {
            openTx--;
          }
        }, cfg)) as typeof db.transaction;
      const dmaps = fake({
        async driveMinutes() {
          calls++;
          if (openTx > 0) callsInTx++;
          await new Promise((r) => setTimeout(r, 5));
          return { minutes: 15, estimate: false };
        },
      });
      const ddeps = { maps: dmaps, now: () => fixedNow };
      // r3 on 2026-12-02 IST: a past pair (later meeting started) and two future pairs.
      const at = (h: number, len = 0.5, address = 'Geo Rd') =>
        M.createMeeting(r3, { title: `ZZ drive ${h}`, type: 'physical', startAt: hours(h), endAt: hours(h + len), address }, deps);
      await at(-3, 0.5, 'Geo Rd');
      const pastLater = await at(-2, 0.5, 'Other Rd');
      await at(1, 0.5, 'Geo Rd');
      const f2 = await at(2, 0.5, 'Other Rd');
      (db as { transaction: typeof db.transaction }).transaction = patched;
      try {
        const v1 = await DY.getDay(r3, { date: '2026-12-02' }, ddeps);
        const first = calls;
        const firstInTx = callsInTx;
        const v2 = await DY.getDay(r3, { date: '2026-12-02' }, ddeps);
        const mine = (v: typeof v1) => v.reps.flatMap((r) => r.meetings);
        const past = mine(v1).find((x) => x.id === pastLater.id)!;
        const fut = mine(v2).find((x) => x.id === f2.id)!;
        check('getDay: misses priced (2 future pairs), past pair not priced', first === 2 && past.risk.estDriveMin === null, {
          first,
          past: past.risk,
        });
        check('getDay: no provider call while a transaction is open', firstInTx === 0 && callsInTx === 0, { firstInTx, callsInTx });
        check('getDay: second call within TTL makes 0 provider calls (cache)', calls === first && fut.risk.estDriveMin === 15 && !fut.risk.estimate, {
          calls,
          fut: fut.risk,
        });
        const stored = await inT(A, (tx) => tx.select().from(s.driveTimeCache).where(sql`${s.driveTimeCache.provider} = 'fake'`));
        check('getDay: real answers stored in one write phase', stored.length >= 2, stored.length);
      } finally {
        (db as { transaction: typeof db.transaction }).transaction = realTx;
      }
    }

    // --- company geocode line: a company with city/state but no point geocodes the full line
    {
      const queries: string[] = [];
      const rec = fake({
        async geocode(address) {
          queries.push(address);
          return { status: 'ok', point: { lat: 28.45, lng: 77.05 } };
        },
      });
      const [lineCo] = await db
        .insert(s.companies)
        .values({ tenantId: A, name: 'ZZ Line Co', address: '12 Main St', city: 'Gurugram', state: 'Haryana', postalCode: '122001' })
        .returning();
      const ml = await M.createMeeting(
        r1,
        { title: 'ZZ line', type: 'physical', startAt: hours(30), endAt: hours(30.5), companyId: lineCo!.id },
        { maps: rec, now: () => fixedNow },
      );
      check(
        'meeting for a company without a point geocodes "address, city, state, postal code"',
        queries.length === 1 && queries[0] === '12 Main St, Gurugram, Haryana, 122001' && ml.address === queries[0] && ml.lat === 28.45,
        { queries, address: ml.address, lat: ml.lat },
      );
    }

    // --- re-site on type change / company change or clear
    {
      const [twoCo] = await db
        .insert(s.companies)
        .values({ tenantId: A, name: 'ZZ Two Co', address: 'Two Rd', city: 'Noida', lat: 28.4, lng: 77.0, geocodeStatus: 'ok' })
        .returning();
      const v = await mk(r1, { type: 'virtual', companyId: siteCo!.id, virtualUrl: 'https://meet.example/x' });
      const vp = await M.updateMeeting(r1, v.id, { type: 'physical' }, deps);
      check('virtual -> physical re-sites from the company', vp.lat === S.lat && vp.lng === S.lng && vp.address === 'Site Rd, Noida' && vp.geocodeStatus === 'ok', vp);
      const c1 = await mk(r1, { companyId: siteCo!.id });
      const cleared = await M.updateMeeting(r1, c1.id, { companyId: null }, deps);
      check('clearing the company drops its inherited site', cleared.companyId === null && cleared.lat === null && cleared.lng === null && cleared.address === null, cleared);
      const c2 = await mk(r1, { companyId: siteCo!.id });
      const moved = await M.updateMeeting(r1, c2.id, { companyId: twoCo!.id }, deps);
      check('changing the company moves an inherited site to the new company', moved.lat === 28.4 && moved.address === 'Two Rd, Noida', moved);
      const c3 = await mk(r1, { companyId: siteCo!.id, address: 'Geo Rd' });
      const own = await M.updateMeeting(r1, c3.id, { companyId: twoCo!.id }, deps);
      check('changing the company keeps (and geocodes) a meeting\'s own address', own.address === 'Geo Rd' && own.lat === 28.6, own);
      const c4 = await mk(r1, { companyId: siteCo!.id, address: 'Geo Rd' });
      const ownCleared = await M.updateMeeting(r1, c4.id, { companyId: null }, deps);
      check('clearing the company keeps a meeting\'s own geocoded address', ownCleared.address === 'Geo Rd' && ownCleared.lat === 28.6, ownCleared);
    }

    // --- company re-geocode propagates to not-started, site-less, inherited meetings
    {
      const [qCo] = await db.insert(s.companies).values({ tenantId: A, name: 'ZZ Q Co', address: 'Q Rd', city: 'Noida' }).returning();
      const qa = await mk(r1, { companyId: qCo!.id }); // inherits 'Q Rd, Noida', fails to geocode
      const qb = await mk(r1, { companyId: qCo!.id, address: 'Nowhere 9' }); // own address, failed
      const qc = await mk(r1, { companyId: qCo!.id, address: 'Geo Rd' }); // own site already
      const qd = await mk(r1, { companyId: qCo!.id });
      await CI.checkIn(r1, qd.id, { ...S, accuracyM: 5 }, deps); // started
      const [qCoNew] = await db
        .update(s.companies)
        .set({ address: 'Q Road 2', lat: 28.33, lng: 77.11, geocodeStatus: 'ok' })
        .where(sql`${s.companies.id} = ${qCo!.id}`)
        .returning();
      const n = await inT(A, (tx) =>
        M.propagateCompanyPoint(tx, A, { ...qCoNew!, lat: 28.33, lng: 77.11 }, ['Q Rd, Noida', 'Q Rd', 'Q Road 2, Noida', 'Q Road 2'], fixedNow),
      );
      const [ra, rb, rc, rd] = [await meetingRow(qa.id), await meetingRow(qb.id), await meetingRow(qc.id), await meetingRow(qd.id)];
      check(
        'company re-geocode propagates only to not-started, site-less, inherited meetings',
        qa.lat === null &&
          n === 1 &&
          ra.lat === 28.33 &&
          ra.geocodeStatus === 'ok' &&
          ra.address === 'Q Road 2, Noida' &&
          rb.lat === null &&
          rc.lat === 28.6 &&
          rd.lat === null,
        { n, a: [ra.lat, ra.address], b: rb.lat, c: rc.lat, d: [rd.lat, rd.status] },
      );
    }

    // --- company site from a pre-fetched verdict (shared by the Add and Edit company actions)
    {
      const SITE = await import('../src/lib/field/site');
      const line = SITE.companyGeocodeLine({ address: 'New Co Rd', city: 'Noida', state: 'UP', postalCode: '201301' });
      check('company line joins address, city, state, postal code', line === 'New Co Rd, Noida, UP, 201301', line);
      const est = getMapsProvider(); // no MAPS_API_KEY here: answers pending
      const prePending = await SITE.fetchPre(line, await inT(A, (tx) => SITE.lookupPre(tx, A, line)), est);
      const pending = await inT(A, (tx) => SITE.companySiteFromPre(tx, A, line, prePending, est.name));
      const cachedAfterPending = await inT(A, (tx) => SITE.lookupPre(tx, A, line));
      check(
        'company site without a key: pending, no coordinates, nothing cached',
        pending.geocodeStatus === 'pending' && pending.lat === null && pending.lng === null && cachedAfterPending === null,
        { pending, cachedAfterPending },
      );
      const okMaps = fake({ async geocode() { return { status: 'ok', point: { lat: 28.44, lng: 77.44 } }; } });
      const preOk = await SITE.fetchPre(line, null, okMaps);
      const ok = await inT(A, (tx) => SITE.companySiteFromPre(tx, A, line, preOk, okMaps.name));
      const cachedOk = await inT(A, (tx) => SITE.lookupPre(tx, A, line));
      check(
        'company site with a verdict: ok point, verdict cached for the next save',
        ok.geocodeStatus === 'ok' && ok.lat === 28.44 && cachedOk?.result.status === 'ok',
        { ok, cachedOk },
      );
      const none = await inT(A, (tx) => SITE.companySiteFromPre(tx, A, null, null, okMaps.name));
      check('company site with no address: no point, no status', none.lat === null && none.geocodeStatus === null, none);
    }
  }

  // ---------------------------------------------------------------- risk scan (Task 5)
  async function riskScanTests() {
    const RS = await import('../src/lib/field/risk-scan');
    const M = await import('../src/lib/field/meetings');
    const CI = await import('../src/lib/field/checkins');
    const OC = await import('../src/lib/field/outcomes');
    type FieldActor = import('../src/lib/field/types').FieldActor;

    const C = await mk('rc');
    const D = await mk('rd');
    extraTenants.push(C, D);
    const uid = (n: string) => `zz_field_${n}_${stamp}`;
    const U = { cm: uid('cm'), c1: uid('c1'), c2: uid('c2'), c3: uid('c3'), c4: uid('c4'), c5: uid('c5'), c6: uid('c6'), c7: uid('c7'), c8: uid('c8'), d1: uid('d1') };
    await db.insert(s.users).values(
      Object.entries(U).map(([k, id]) => ({ id, email: `${id}@example.test`, firstName: k.toUpperCase(), lastName: 'Scan' })),
    );
    await db.insert(s.memberships).values([
      { tenantId: C, userId: U.cm, role: 'manager' as const },
      { tenantId: C, userId: U.c1, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c2, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c3, role: 'member' as const },
      { tenantId: C, userId: U.c4, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c5, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c6, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c7, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: C, userId: U.c8, role: 'member' as const, reportsToUserId: U.cm },
      { tenantId: D, userId: U.d1, role: 'member' as const },
    ]);
    const act = (tenantId: string, userId: string, role: FieldActor['role']): FieldActor => ({ tenantId, userId, role });
    const N = new Date('2026-12-10T05:00:00Z'); // 10:30 IST, inside 09:00-19:00
    const min = (n: number) => new Date(N.getTime() + n * 60_000);
    let driveCalls = 0;
    let driveMin = 25;
    const maps: MapsProvider = {
      name: 'fake',
      async geocode() {
        return { status: 'failed' };
      },
      async reverseGeocode() {
        return 'x';
      },
      async driveMinutes() {
        driveCalls++;
        return { minutes: driveMin, estimate: false };
      },
      async resolveShortUrl() {
        return null;
      },
    };
    const deps = { maps, now: () => N };
    const scanDeps = { maps, now: () => N };
    const S1 = { lat: 28.5355, lng: 77.391 };
    const S2 = { lat: 28.6, lng: 77.2 };
    type Ins = {
      tenantId: string;
      ownerId: string;
      title: string;
      start: number;
      end: number;
      site?: { lat: number; lng: number };
      virtual?: boolean;
      status?: 'planned' | 'checked_out';
      checkedOutMin?: number;
    };
    const ins = async (x: Ins) => {
      const [r] = await db
        .insert(s.meetings)
        .values({
          tenantId: x.tenantId,
          ownerId: x.ownerId,
          title: x.title,
          type: x.virtual ? 'virtual' : 'physical',
          startAt: min(x.start),
          endAt: min(x.end),
          lat: x.site?.lat ?? null,
          lng: x.site?.lng ?? null,
          geocodeStatus: x.site ? 'ok' : 'pending',
          status: x.status ?? 'planned',
          checkedInAt: x.status === 'checked_out' ? min(x.start) : null,
          checkedOutAt: x.checkedOutMin !== undefined ? min(x.checkedOutMin) : null,
        })
        .returning();
      return r!;
    };
    const row = async (t: string, id: string) =>
      (await inT(t, (tx) => tx.select().from(s.meetings).where(sql`${s.meetings.id} = ${id}`)))[0]!;
    const reasons = async (t: string, id: string) => (await row(t, id)).atRiskReasons;
    // Notifications are recipient-scoped under RLS; read them as the service role.
    const notifsFor = async (t: string, id: string) =>
      db
        .select()
        .from(s.notifications)
        .where(sql`${s.notifications.tenantId} = ${t} AND ${s.notifications.entityId} = ${id} AND ${s.notifications.type} = 'field_meeting_at_risk'`);
    const j = JSON.stringify;

    // 1/2: acceptance: start+16 amber, exactly one notification per recipient
    const a1 = await ins({ tenantId: C, ownerId: U.c1, title: 'ZZ Acme visit', start: -16, end: 14 });
    const a3 = await ins({ tenantId: C, ownerId: U.c3, title: 'ZZ Solo visit', start: -16, end: 14 });
    // 3: travel gap on the later meeting (gap 20 min, drive 25)
    const tP = await ins({ tenantId: C, ownerId: U.c2, title: 'ZZ tp', start: 60, end: 90, site: S1 });
    const tQ = await ins({ tenantId: C, ownerId: U.c2, title: 'ZZ tq', start: 110, end: 140, site: S2 });
    // 4: overlap
    const oX = await ins({ tenantId: C, ownerId: U.c4, title: 'ZZ ox', start: 180, end: 240, virtual: true });
    const oY = await ins({ tenantId: C, ownerId: U.c4, title: 'ZZ oy', start: 210, end: 270, virtual: true });
    // 5: check-in clears
    const k5 = await ins({ tenantId: C, ownerId: U.c5, title: 'ZZ k5', start: -30, end: 0, site: S1 });
    // 6: mom_missing (checked out 3 h ago, no outcome)
    const k6 = await ins({ tenantId: C, ownerId: U.c6, title: 'ZZ k6', start: -300, end: -240, site: S1, status: 'checked_out', checkedOutMin: -180 });
    // cross-tenant meeting in D
    const dm = await ins({ tenantId: D, ownerId: U.d1, title: 'ZZ dm', start: -40, end: -10 });

    const r1st = await RS.scanTenantRisks(C, scanDeps);
    const r2nd = await RS.scanTenantRisks(C, scanDeps);
    const n1 = await notifsFor(C, a1.id);
    check(
      'acceptance: start+16 amber and exactly one manager notification',
      j(await reasons(C, a1.id)) === '["no_checkin"]' &&
        n1.length === 2 &&
        n1.filter((n) => n.recipientUserId === U.cm).length === 1 &&
        n1.filter((n) => n.recipientUserId === U.c1).length === 1 &&
        r2nd.notified === 0 &&
        r1st.scanned >= 8,
      { reasons: await reasons(C, a1.id), n1: n1.map((n) => n.recipientUserId), r1st, r2nd },
    );
    const n1row = n1.find((n) => n.recipientUserId === U.cm);
    check(
      'notification copy, entity and metadata',
      !!n1row &&
        n1row.title === 'No check-in: ZZ Acme visit' &&
        n1row.subtitle === 'C1 Scan · 10:14' &&
        n1row.entityType === 'meeting' &&
        j(n1row.metadata) === '{"reason":"no_checkin"}' &&
        n1row.actorUserId === null,
      n1row,
    );
    const n3 = await notifsFor(C, a3.id);
    check('rep without manager notifies only the rep', n3.length === 1 && n3[0]!.recipientUserId === U.c3, n3.map((n) => n.recipientUserId));
    check(
      'acceptance: 12 km / 20 min travel_gap persisted on the later meeting',
      j(await reasons(C, tQ.id)) === '["travel_gap"]' && j(await reasons(C, tP.id)) === '[]' && (await notifsFor(C, tQ.id)).length === 2,
      { q: await reasons(C, tQ.id), p: await reasons(C, tP.id) },
    );
    check('overlap flags both meetings', j(await reasons(C, oX.id)) === '["overlap"]' && j(await reasons(C, oY.id)) === '["overlap"]');
    check('mom_missing flagged after 2h', j(await reasons(C, k6.id)) === '["mom_missing"]', await reasons(C, k6.id));

    // reschedule clears overlap, no new notifications
    const nOverlapBefore = (await notifsFor(C, oX.id)).length + (await notifsFor(C, oY.id)).length;
    await M.updateMeeting(act(C, U.c4, 'member'), oY.id, { startAt: min(300), endAt: min(360) }, deps);
    const rr = await RS.scanTenantRisks(C, scanDeps);
    const nOverlapAfter = (await notifsFor(C, oX.id)).length + (await notifsFor(C, oY.id)).length;
    check(
      'reschedule clears overlap',
      j(await reasons(C, oX.id)) === '[]' && j(await reasons(C, oY.id)) === '[]' && nOverlapAfter === nOverlapBefore && rr.cleared >= 2,
      { x: await reasons(C, oX.id), y: await reasons(C, oY.id), nOverlapBefore, nOverlapAfter, rr },
    );

    // check-in clears no_checkin; clear then re-appear notifies again
    check('k5 flagged before check-in', j(await reasons(C, k5.id)) === '["no_checkin"]', await reasons(C, k5.id));
    const nk5a = (await notifsFor(C, k5.id)).length;
    await CI.checkIn(act(C, U.c5, 'member'), k5.id, { ...S1, accuracyM: 5 }, deps);
    check('checkIn clears stored no_checkin immediately', j(await reasons(C, k5.id)) === '[]', await reasons(C, k5.id));
    await RS.scanTenantRisks(C, scanDeps);
    check('flag clears after check-in', j(await reasons(C, k5.id)) === '[]', await reasons(C, k5.id));
    await db.execute(sql`UPDATE meetings SET status = 'planned', checked_in_at = NULL WHERE id = ${k5.id}`);
    await RS.scanTenantRisks(C, scanDeps);
    check(
      're-appearing flag notifies again',
      j(await reasons(C, k5.id)) === '["no_checkin"]' && (await notifsFor(C, k5.id)).length === nk5a * 2,
      { before: nk5a, after: (await notifsFor(C, k5.id)).length },
    );

    // mom_missing cleared by outcome
    await OC.saveOutcome(act(C, U.c6, 'member'), k6.id, { momText: 'done' }, deps);
    const nk6 = (await notifsFor(C, k6.id)).length;
    await RS.scanTenantRisks(C, scanDeps);
    check('mom_missing cleared by outcome', j(await reasons(C, k6.id)) === '[]' && (await notifsFor(C, k6.id)).length === nk6, await reasons(C, k6.id));

    // travel_gap is frozen once the later meeting started: no re-pricing, no flip, no re-notify
    const pP = await ins({ tenantId: C, ownerId: U.c7, title: 'ZZ pp', start: -400, end: -370, site: S1 });
    const pQ = await ins({ tenantId: C, ownerId: U.c7, title: 'ZZ pq', start: -340, end: -310, site: S2 });
    await db.execute(sql`UPDATE meetings SET at_risk_reasons = '{travel_gap}' WHERE id = ${pQ.id}`);
    // cross-day pair: late yesterday (22:50 IST) -> early today (11:00 IST, still ahead)
    await ins({ tenantId: C, ownerId: U.c8, title: 'ZZ xa', start: -700, end: -680, site: S1 });
    await ins({ tenantId: C, ownerId: U.c8, title: 'ZZ xb', start: 30, end: 60, site: S2 });
    const callsBefore = driveCalls;
    driveMin = 5; // would clear the flag if the past pair were re-priced
    const tgNotifs = async () =>
      (await notifsFor(C, pQ.id)).filter((n) => (n.metadata as { reason?: string }).reason === 'travel_gap').length;
    const nPQ = await tgNotifs();
    await RS.scanTenantRisks(C, scanDeps);
    driveMin = 25;
    await RS.scanTenantRisks(C, scanDeps);
    check(
      'past travel_gap pair is frozen (no drive call, no flip, no re-notify)',
      driveCalls === callsBefore && (await reasons(C, pQ.id)).includes('travel_gap') && j(await reasons(C, pP.id)).includes('travel_gap') === false && (await tgNotifs()) === nPQ,
      { calls: driveCalls - callsBefore, q: await reasons(C, pQ.id) },
    );
    check('cross-day pair makes no drive call', driveCalls === callsBefore, driveCalls - callsBefore);

    // CAS: an owner edit landing between compute and write makes the swap miss
    const cas = await ins({ tenantId: C, ownerId: U.c3, title: 'ZZ cas', start: -200, end: -190 });
    const casScan = await RS.scanTenantRisks(C, {
      ...scanDeps,
      afterCompute: async () => {
        await db.execute(sql`UPDATE meetings SET owner_id = ${U.c2}, updated_at = now() WHERE id = ${cas.id}`);
      },
    });
    check(
      'stale scan (owner edited mid-scan) swaps nothing and notifies no one',
      casScan.notified === 0 && j(await reasons(C, cas.id)) === '[]' && (await notifsFor(C, cas.id)).length === 0,
      { casScan, reasons: await reasons(C, cas.id) },
    );
    const casNext = await RS.scanTenantRisks(C, scanDeps);
    const casN = await notifsFor(C, cas.id);
    check(
      'next scan flags it for the new owner and manager only',
      casNext.notified === 2 &&
        j(await reasons(C, cas.id)) === '["no_checkin"]' &&
        casN.map((n) => n.recipientUserId).sort().join() === [U.c2, U.cm].sort().join(),
      { casNext, to: casN.map((n) => n.recipientUserId) },
    );

    // cross-tenant: scanning C never touched D
    check(
      'cross-tenant: scanning A never touches B',
      j(await reasons(D, dm.id)) === '[]' && (await notifsFor(D, dm.id)).length === 0,
      await reasons(D, dm.id),
    );
    const rd = await RS.scanTenantRisks(D, scanDeps);
    check(
      'cross-tenant: scanning D flags D',
      rd.scanned === 1 && j(await reasons(D, dm.id)) === '["no_checkin"]' && (await notifsFor(D, dm.id)).length === 1,
      rd,
    );

    // tracking hours: 21:00 IST skipped unless ignoreHours
    const night = { maps, now: () => new Date('2026-12-10T15:30:00Z') };
    const rn = await RS.scanTenantRisks(C, night);
    const rni = await RS.scanTenantRisks(C, { ...night, ignoreHours: true });
    check('outside tracking hours skipped', rn.scanned === 0 && rn.notified === 0 && rni.scanned > 0, { rn, rni });

    // tenant selection
    const ids = await RS.tenantsWithMeetingsInWindow(N);
    check('tenant selection includes C and D', ids.includes(C) && ids.includes(D), ids);
    const far = await RS.tenantsWithMeetingsInWindow(new Date('2027-06-01T00:00:00Z'));
    check('tenant selection excludes out-of-window tenants', !far.includes(C) && !far.includes(D), far);
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
