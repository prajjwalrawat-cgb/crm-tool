process.env.DATABASE_URL ??= 'postgres://selftest@127.0.0.1:1/never';

import { haversineMeters, estimateDriveMinutes, parseSiteInput } from '../src/lib/field/geo';
import { MEETING_TRANSITIONS, assertTransition } from '../src/lib/field/state-machine';
import { computeRisks, diffReasons, type RiskMeeting, type DriveFn } from '../src/lib/field/risk';
import { computeKpis } from '../src/lib/field/kpis';
import { FieldError } from '../src/lib/field/types';
import { GoogleProvider } from '../src/lib/field/maps/google';
import { EstimateProvider } from '../src/lib/field/maps/estimate';
import type { MeetingStatus } from '../src/db/schema/enums';

/**
 * Pure self-test for the Field Meetings core (no DB).
 *   tsx scripts/selftest-field.ts
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

const noida = { lat: 28.5708, lng: 77.3261 };
const cyber = { lat: 28.495, lng: 77.0895 };
const north = (m: number) => ({ lat: noida.lat + m / 111195, lng: noida.lng });
{
  const km = haversineMeters(noida, cyber) / 1000;
  check('haversine known pair', Math.abs(km - 24.4) <= 0.3, km);
}
{
  check('radius: 500 m > 300', haversineMeters(noida, north(500)) > 300);
  check('radius: 50 m < 300', haversineMeters(noida, north(50)) < 300);
}
{
  const m = estimateDriveMinutes(noida, north(12000));
  check('drive estimate 12 km', m >= 39 && m <= 42, m);
  check('drive estimate same point = 0', estimateDriveMinutes(noida, noida) === 0);
}
{
  const eq = (r: ReturnType<typeof parseSiteInput>) =>
    r?.kind === 'point' && Math.abs(r.point.lat - 28.5355) < 1e-9 && Math.abs(r.point.lng - 77.391) < 1e-9;
  check('parse @lat,lng', eq(parseSiteInput('https://www.google.com/maps/place/Noida/@28.5355,77.391,15z')));
  check('parse ?q=', eq(parseSiteInput('https://maps.google.com/?q=28.5355,77.391')));
  check('parse query=', eq(parseSiteInput('https://www.google.com/maps/search/?api=1&query=28.5355,77.391')));
  check('parse bare pair', eq(parseSiteInput('28.5355, 77.391')));
  check('parse junk -> null', parseSiteInput('near metro') === null);
  check('parse 0,0 -> null', parseSiteInput('0,0') === null);
  check('parse out of range -> null', parseSiteInput('95, 10') === null);
  const s = parseSiteInput('https://maps.app.goo.gl/abc');
  check('parse short url', s?.kind === 'short_url' && s.url === 'https://maps.app.goo.gl/abc', s);
  check('parse goo.gl/maps short url', parseSiteInput('https://goo.gl/maps/xyz')?.kind === 'short_url');
}
{
  const all: MeetingStatus[] = ['planned', 'en_route', 'arrived', 'checked_in', 'checked_out', 'mom_logged', 'cancelled'];
  const edges: Array<[MeetingStatus, MeetingStatus]> = [
    ['planned', 'en_route'], ['planned', 'arrived'], ['planned', 'checked_in'], ['planned', 'cancelled'],
    ['en_route', 'planned'], ['en_route', 'arrived'], ['en_route', 'checked_in'], ['en_route', 'cancelled'],
    ['arrived', 'checked_in'], ['arrived', 'cancelled'], ['checked_in', 'checked_out'], ['checked_out', 'mom_logged'],
  ];
  const throws = (f: MeetingStatus, t: MeetingStatus, ty: 'physical' | 'virtual') => {
    try {
      assertTransition(f, t, ty);
      return false;
    } catch (e) {
      return e instanceof FieldError && e.code === 'invalid_transition';
    }
  };
  check('state: allowed edges pass', edges.every(([f, t]) => !throws(f, t, 'physical')));
  check('state: checked_out -> checked_in throws', throws('checked_out', 'checked_in', 'physical'));
  check('state: cancelled -> planned throws', throws('cancelled', 'planned', 'physical'));
  check('state: mom_logged -> * throws', all.every((t) => throws('mom_logged', t, 'physical')));
  check('state: planned -> mom_logged physical throws', throws('planned', 'mom_logged', 'physical'));
  check('state: planned -> mom_logged virtual passes', !throws('planned', 'mom_logged', 'virtual'));
  check('state: table has all statuses', all.every((s) => Array.isArray(MEETING_TRANSITIONS[s])));
}

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 25, h, m));
const settings = { graceMin: 15, momDueHours: 2 };
const estDrive: DriveFn = async (a, b) => ({ minutes: estimateDriveMinutes(a, b), estimate: true });
const mk = (o: Partial<RiskMeeting> & { id: string }): RiskMeeting => ({
  ownerId: 'u1',
  type: 'physical',
  status: 'planned',
  startAt: T(10),
  endAt: T(11),
  site: null,
  checkedOutAt: null,
  hasOutcome: false,
  ...o,
});
const risk = async (ms: RiskMeeting[], now: Date) => computeRisks(ms, now, settings, estDrive);

async function main() {
  {
    const start = T(10);
    const at = (min: number) => new Date(start.getTime() + min * 60000);
    const r16 = await risk([mk({ id: 'a' })], at(16));
    check('no_checkin at start+16', JSON.stringify(r16.get('a')?.reasons) === '["no_checkin"]', r16.get('a'));
    const r14 = await risk([mk({ id: 'a' })], at(14));
    check('no_checkin at start+14 none', r14.get('a')?.reasons.length === 0);
    const rv = await risk([mk({ id: 'a', type: 'virtual' })], at(16));
    check('no_checkin virtual none', rv.get('a')?.reasons.length === 0);
    const rc = await risk([mk({ id: 'a', status: 'checked_in' })], at(16));
    check('no_checkin checked_in none', rc.get('a')?.reasons.length === 0);
  }
  {
    const now = T(9);
    const a = mk({ id: 'a', type: 'virtual', startAt: T(10), endAt: T(11) });
    const b = mk({ id: 'b', type: 'virtual', startAt: T(10, 30), endAt: T(11, 30) });
    const r = await risk([a, b], now);
    check('overlap both flagged', r.get('a')?.reasons.includes('overlap') === true && r.get('b')?.reasons.includes('overlap') === true);
    const r2 = await risk([a, { ...b, ownerId: 'u2' }], now);
    check('overlap different owners none', !r2.get('a')?.reasons.length && !r2.get('b')?.reasons.length);
    const r3 = await risk([a, { ...b, startAt: T(11), endAt: T(12) }], now);
    check('overlap touching none', !r3.get('a')?.reasons.length && !r3.get('b')?.reasons.length);
    const r4 = await risk([a, { ...b, status: 'cancelled' }], now);
    check('overlap cancelled none', !r4.get('a')?.reasons.length && r4.get('b')?.reasons.length === 0);
  }
  {
    const now = T(9);
    const A = mk({ id: 'A', startAt: T(10), endAt: T(11), site: noida });
    const B = mk({ id: 'B', startAt: T(11, 20), endAt: T(12), site: north(12000) });
    const r = await risk([A, B], now);
    const b = r.get('B')!;
    check(
      'travel_gap flagged on later',
      b.reasons.includes('travel_gap') && b.travelGapMin === 20 && (b.estDriveMin ?? 0) >= 39 && b.estimate === true,
      b,
    );
    check('travel_gap not on earlier', !r.get('A')!.reasons.includes('travel_gap') && r.get('A')!.travelGapMin === null);
    const ov = (site: { lat: number; lng: number }) => [
      mk({ id: 'A', startAt: T(10), endAt: T(11), site: noida }),
      mk({ id: 'B', startAt: T(10, 30), endAt: T(11, 30), site }),
    ];
    const o1 = (await risk(ov(noida), now)).get('B')!;
    check('overlap same site: no travel_gap, gap null', o1.reasons.includes('overlap') && !o1.reasons.includes('travel_gap') && o1.travelGapMin === null, o1);
    const o2 = (await risk(ov(north(12000)), now)).get('B')!;
    check('overlap 12 km: overlap only', JSON.stringify(o2.reasons) === '["overlap"]' && o2.travelGapMin === null && (o2.estDriveMin ?? 0) >= 39, o2);
    const b2b = (await risk([
      mk({ id: 'A', startAt: T(10), endAt: T(11), site: noida }),
      mk({ id: 'B', startAt: T(11), endAt: T(12), site: north(5000) }),
    ], now)).get('B')!;
    check('back-to-back 5 km: travel_gap, gap 0', JSON.stringify(b2b.reasons) === '["travel_gap"]' && b2b.travelGapMin === 0, b2b);
    const mid = mk({ id: 'M', startAt: T(11, 5), endAt: T(11, 10), site: null });
    const r2 = await risk([A, mid, B], now);
    check('travel_gap skips site-less', r2.get('B')!.reasons.includes('travel_gap') && !r2.get('M')!.reasons.includes('travel_gap'));
  }
  {
    const now = T(14);
    const co = (min: number) => new Date(now.getTime() - min * 60000);
    const base = { status: 'checked_out' as MeetingStatus, type: 'virtual' as const };
    const r1 = await risk([mk({ id: 'a', ...base, checkedOutAt: co(121) })], now);
    check('mom_missing 2h01m flagged', JSON.stringify(r1.get('a')?.reasons) === '["mom_missing"]', r1.get('a'));
    const r2 = await risk([mk({ id: 'a', ...base, checkedOutAt: co(121), hasOutcome: true })], now);
    check('mom_missing with outcome none', r2.get('a')?.reasons.length === 0);
    const r3 = await risk([mk({ id: 'a', ...base, checkedOutAt: co(119) })], now);
    check('mom_missing 1h59m none', r3.get('a')?.reasons.length === 0);
  }
  {
    const d = diffReasons(['overlap'], ['overlap', 'no_checkin']);
    check('diffReasons', JSON.stringify(d) === '{"added":["no_checkin"],"removed":[]}', d);
  }
  {
    const row = (status: MeetingStatus, dealId: string | null, amountMinor: number | null, currency: string | null, atRisk = false) => ({
      status,
      atRisk,
      dealId,
      amountMinor,
      currency,
    });
    const k = computeKpis(
      [
        row('planned', 'X', 10000000, 'INR'),
        row('checked_in', 'X', 10000000, 'INR', true),
        row('mom_logged', 'X', 10000000, 'INR'),
        row('planned', 'Y', 5000000, 'INR'),
        row('planned', 'Z', 99900, 'USD'),
        row('cancelled', 'W', 100, 'INR'),
      ],
      'INR',
    );
    check('kpi distinct deals', k.pipelineMinor === 15000000 && k.otherCurrencyDeals === 1, k);
    check('kpi counts', k.planned === 5 && k.checkedIn === 2 && k.atRisk === 1, k);
  }

  // ---- maps providers (no network: fetch is injected) ----
  {
    const urls: string[] = [];
    const fakeFetch = async (u: string) => {
      urls.push(u);
      return new Response(
        JSON.stringify({
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', duration: { value: 600 }, duration_in_traffic: { value: 1500 } }] }],
        }),
        { status: 200 },
      );
    };
    const g = new GoogleProvider('KEY123', fakeFetch);
    const depart = new Date(Date.now() + 3600_000);
    const r = await g.driveMinutes(noida, cyber, depart);
    const unix = Math.floor(depart.getTime() / 1000);
    check(
      'google provider builds Distance Matrix URL with departure_time',
      urls[0]!.includes('distancematrix') &&
        urls[0]!.includes(`departure_time=${unix}`) &&
        urls[0]!.includes('key=KEY123') &&
        urls[0]!.includes('traffic_model=best_guess'),
      urls[0],
    );
    check('google drive parses duration_in_traffic', r.minutes === 25 && r.estimate === false, r);

    const gfail = new GoogleProvider('K', async () => new Response('x', { status: 500 }));
    const rf = await gfail.driveMinutes(noida, cyber, depart);
    check('google drive falls back to estimate on error', rf.estimate === true && rf.minutes > 0, rf);

    const gz = new GoogleProvider('K', async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }));
    check('google geocode ZERO_RESULTS is failed', (await gz.geocode('nowhere')).status === 'failed');
    const gq = new GoogleProvider('K', async () => new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT' }), { status: 200 }));
    check('google geocode quota error is pending, not failed', (await gq.geocode('x')).status === 'pending');

    const e = new EstimateProvider();
    const eg = await e.geocode('Sector 62 Noida');
    check('estimate geocode is pending, never a fake point', eg.status === 'pending' && eg.point === undefined, eg);
    check('estimate reverseGeocode format', (await e.reverseGeocode({ lat: 28.5355, lng: 77.391 })) === '28.53550, 77.39100');
    const ed = await e.driveMinutes(noida, cyber, depart);
    check('estimate drive flagged estimate', ed.estimate === true && ed.minutes === estimateDriveMinutes(noida, cyber), ed);
    {
      let calls = 0;
      const mk = (status: number, location?: string) =>
        new EstimateProvider(async () => {
          calls++;
          return new Response(null, { status, headers: location ? { location } : {} });
        });
      const good = 'https://www.google.com/maps/place/Noida/@28.5,77.3,15z';
      for (const bad of ['http://127.0.0.1/x', 'https://example.com/x', 'http://goo.gl/x', 'https://169.254.169.254/maps', 'not a url']) {
        check(`resolveShortUrl rejects ${bad} without fetching`, (await mk(302, good).resolveShortUrl(bad)) === null && calls === 0, calls);
      }
      check('resolveShortUrl 200 returns null', (await mk(200, good).resolveShortUrl('https://goo.gl/x')) === null);
      check('resolveShortUrl non-Google Location returns null', (await mk(302, 'https://evil.example.com/maps').resolveShortUrl('https://goo.gl/x')) === null);
      check('resolveShortUrl http Location returns null', (await mk(302, 'http://www.google.com/maps/x').resolveShortUrl('https://goo.gl/x')) === null);
      check('resolveShortUrl goo.gl -> google maps returns Location', (await mk(302, good).resolveShortUrl('https://goo.gl/x')) === good);
      check('resolveShortUrl maps.app.goo.gl ok', (await mk(301, good).resolveShortUrl('https://maps.app.goo.gl/abc')) === good);
      check('resolveShortUrl google.com/maps input ok', (await mk(302, good).resolveShortUrl('https://www.google.com/maps/x')) === good);
      for (const bad of ['https://www.google.evl.cd/maps', 'https://www.google.xyz/maps', 'https://goo.gl.evil.com/x', 'https://user@goo.gl@evil.com/x', 'https://www.google.com.evil.com/maps']) {
        const before = calls;
        check(`resolveShortUrl rejects ${bad} without fetching`, (await mk(302, good).resolveShortUrl(bad)) === null && calls === before, calls);
      }
      check('resolveShortUrl Location on look-alike TLD returns null', (await mk(302, 'https://www.google.ab.cd/maps/x').resolveShortUrl('https://goo.gl/x')) === null);
      check('resolveShortUrl google.co.in/maps input ok', (await mk(302, good).resolveShortUrl('https://www.google.co.in/maps/x')) === good);
      check('resolveShortUrl google.com non-maps path rejected', (await mk(302, good).resolveShortUrl('https://www.google.com/search')) === null);
    }
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nfield selftest: ${passed} passed, ${results.length - passed} failed`);
  process.exit(exitCode);
}
void main();
