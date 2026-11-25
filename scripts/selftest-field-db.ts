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
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
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
