process.env.DATABASE_URL ??= 'postgres://selftest@127.0.0.1:1/never';

import { haversineMeters, estimateDriveMinutes, parseSiteInput } from '../src/lib/field/geo';
import { MEETING_TRANSITIONS, assertTransition } from '../src/lib/field/state-machine';
import { computeRisks, diffReasons, type RiskMeeting, type DriveFn } from '../src/lib/field/risk';
import { computeKpis } from '../src/lib/field/kpis';
import { FieldError } from '../src/lib/field/types';
import { GoogleProvider } from '../src/lib/field/maps/google';
import { EstimateProvider } from '../src/lib/field/maps/estimate';
import { ZodError } from 'zod';
import {
  fieldErrorResponse,
  parseCheckInBody,
  parseCreateBody,
  parseDayQuery,
  parseOutcomeBody,
  parsePickerQuery,
  parseUpdateBody,
  setFieldErrorReporter,
} from '../src/app/api/field/_lib/http';
import type { MeetingStatus } from '../src/db/schema/enums';
import { formatTimeInTz, isoToZonedInput, isValidDate, shiftDate, todayInTz, zonedInputToIso } from '../src/app/dashboard/field/_lib/datetime';
import { directionsUrl } from '../src/app/dashboard/field/_lib/maps-link';
import { geoErrorMessage, isLowAccuracy } from '../src/app/dashboard/field/_lib/geolocate';
import { MIN_BLOCK_PCT, blockColor, blockGeometry, layoutLane, type LaneItem } from '../src/app/dashboard/field/_lib/timeline';
import { checkinWindow, checkinWindowState } from '../src/lib/field/checkin-window';
import { checkinGateLabel } from '../src/app/dashboard/field/_lib/checkin-gate';
import { applyPick, sameAsCompany, siteCheck, toPickerCompany, type Links, type PickerChoice } from '../src/lib/field/picker-link';
import { companyGeocodeLine, isCompanyAddress } from '../src/lib/field/site-line';
import { lateBy } from '../src/lib/field/late';
import { canCancelMeeting, canEditMeeting, editErrorText, editGates, meetingPatch, type MeetingFormValues } from '../src/app/dashboard/field/_lib/meeting-edit';

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
  const h = parseSiteInput('http://maps.app.goo.gl/abc');
  check('parse http short url upgraded to https', h?.kind === 'short_url' && h.url === 'https://maps.app.goo.gl/abc', h);
  const place = parseSiteInput(
    'https://www.google.com/maps/place/Acme/@28.6000,77.2000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d28.5355!4d77.391!16s%2Fg%2F1',
  );
  check('parse /place/ prefers !3d!4d (place) over @ (camera)', eq(place), place);
  check('parse camera-only @ still works', parseSiteInput('https://www.google.com/maps/@28.61,77.21,15z')?.kind === 'point');
  check('parse ?q=lat%2Clng', eq(parseSiteInput('https://maps.google.com/?q=28.5355%2C77.391')));
  check('parse query=lat%2clng (lower-case)', eq(parseSiteInput('https://www.google.com/maps/search/?api=1&query=28.5355%2c77.391')));
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
    // Virtual meetings are never checked out: due from the end time while still planned.
    const end = (min: number) => new Date(now.getTime() - min * 60000);
    const v = (o: Partial<RiskMeeting>) => mk({ id: 'v', type: 'virtual', startAt: end(181), endAt: end(121), ...o });
    check('mom_missing virtual planned end+2h01m flagged', JSON.stringify((await risk([v({})], now)).get('v')?.reasons) === '["mom_missing"]');
    check('mom_missing virtual planned end+1h59m none', (await risk([v({ startAt: end(179), endAt: end(119) })], now)).get('v')?.reasons.length === 0);
    check('mom_missing virtual with outcome none', (await risk([v({ hasOutcome: true })], now)).get('v')?.reasons.length === 0);
    check('mom_missing virtual mom_logged none', (await risk([v({ status: 'mom_logged', hasOutcome: true })], now)).get('v')?.reasons.length === 0);
    check('mom_missing virtual cancelled none', (await risk([v({ status: 'cancelled' })], now)).get('v')?.reasons.length === 0);
    check('mom_missing physical planned (no check-out) none', (await risk([v({ type: 'physical' })], now)).get('v')?.reasons.includes('mom_missing') === false);
  }
  {
    // A drive function may answer null (no figure): no estimate, no travel_gap.
    const A = mk({ id: 'A', startAt: T(10), endAt: T(11), site: noida });
    const B = mk({ id: 'B', startAt: T(11, 5), endAt: T(12), site: north(12000) });
    const r = await computeRisks([A, B], T(9), settings, async () => null);
    const b = r.get('B')!;
    check('drive null -> no figure, no travel_gap', b.estDriveMin === null && b.travelGapMin === null && b.reasons.length === 0, b);
    let seen: string | null = null;
    await computeRisks([A, B], T(9), settings, async (_a, _b, _d, next) => ((seen = next.id), null));
    check('drive fn receives the later meeting', seen === 'B', seen);
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
    let sawSignal = false;
    const gs = new GoogleProvider('K', async (_u, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 });
    });
    await gs.geocode('x');
    check('google requests carry an abort signal (timeout)', sawSignal);
    const ghang = new GoogleProvider('K', (_u, init) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    );
    const t0h = Date.now();
    const keepAlive = setTimeout(() => {}, 10_000); // AbortSignal.timeout's timer is unref'd
    const hung = await ghang.geocode('slow');
    clearTimeout(keepAlive);
    check('google geocode times out to pending within ~4 s', hung.status === 'pending' && Date.now() - t0h < 6000, Date.now() - t0h);

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

  // ---- HTTP layer (pure): error mapping + body parsing ----
  {
    const origErr = console.error;
    console.error = () => {};
    const j = async (e: unknown) => {
      const r = fieldErrorResponse(e);
      return { status: r.status, body: (await r.json()) as Record<string, unknown>, cache: r.headers.get('Cache-Control') };
    };
    const rad = await j(new FieldError('outside_radius', 'Too far', { distanceM: 500, radiusM: 200 }));
    check('http outside_radius 422 with code/distanceM/radiusM', rad.status === 422 && rad.body.code === 'outside_radius' && rad.body.distanceM === 500 && rad.body.radiusM === 200 && rad.cache === 'no-store', rad);
    const win = await j(new FieldError('outside_window', 'Not yet', { opensAt: new Date('2026-12-02T03:00:00Z'), closesAt: new Date('2026-12-02T09:30:00Z') }));
    check(
      'http outside_window 422 with ISO opensAt/closesAt',
      win.status === 422 && win.body.code === 'outside_window' && win.body.error === 'Not yet' && win.body.opensAt === '2026-12-02T03:00:00.000Z' && win.body.closesAt === '2026-12-02T09:30:00.000Z',
      win,
    );
    check('http invalid_transition 409', (await j(new FieldError('invalid_transition', 'x'))).status === 409);
    check('http not_found 404', (await j(new FieldError('not_found', 'x'))).status === 404);
    check('http forbidden 403', (await j(new FieldError('forbidden', 'x'))).status === 403);
    const val = await j(new FieldError('validation', 'bad'));
    check('http validation 400', val.status === 400 && val.body.code === 'validation' && val.body.error === 'bad', val);
    let zerr: unknown;
    try { parseCheckInBody({ lat: 91, lng: 0, accuracyM: 5 }); } catch (e) { zerr = e; }
    const zr = await j(zerr);
    check('http ZodError 400 with issues', zerr instanceof ZodError && zr.status === 400 && zr.body.code === 'validation' && Array.isArray(zr.body.issues), zr);
    let reported: unknown = null;
    setFieldErrorReporter((e) => { reported = e; });
    const unk = await j(new Error('secret db password leaked'));
    check('http unknown 500 no leak', unk.status === 500 && unk.body.error === 'Something went wrong.' && !JSON.stringify(unk.body).includes('secret') && reported instanceof Error, unk);
    console.error = origErr;

    const throwsZod = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof ZodError; } };
    check('parseCheckInBody ok', parseCheckInBody({ lat: 28.5, lng: 77.3, accuracyM: 12, overrideReason: 'gate' }).overrideReason === 'gate');
    check('parseCheckInBody rejects lat 91', throwsZod(() => parseCheckInBody({ lat: 91, lng: 0, accuracyM: 5 })));
    check('parseCheckInBody rejects missing accuracyM', throwsZod(() => parseCheckInBody({ lat: 1, lng: 1 })));
    check('parseCheckInBody rejects string lat', throwsZod(() => parseCheckInBody({ lat: '1', lng: 1, accuracyM: 5 })));
    check('parseCheckInBody rejects non-object', throwsZod(() => parseCheckInBody(null)));
    check('parseDayQuery bad date', throwsZod(() => parseDayQuery(new URLSearchParams('date=bad'))));
    check('parseDayQuery missing date', throwsZod(() => parseDayQuery(new URLSearchParams(''))));
    const dq = parseDayQuery(new URLSearchParams('date=2026-11-25&repId=user_1&atRiskOnly=true'));
    check('parseDayQuery ok', dq.date === '2026-11-25' && dq.repId === 'user_1' && dq.atRiskOnly === true, dq);
    const cm = parseCreateBody({ title: 'T', type: 'physical', startAt: '2026-11-25T10:00:00Z', endAt: '2026-11-25T11:00:00+05:30', ownerId: 'user_2', dealId: null });
    check('parseCreateBody dates -> Date', cm.startAt instanceof Date && cm.endAt instanceof Date && cm.dealId === null, cm);
    check('parseCreateBody rejects bad date', throwsZod(() => parseCreateBody({ title: 'T', type: 'virtual', startAt: 'nope', endAt: 'nope' })));
    check('parseCreateBody rejects non-uuid dealId', throwsZod(() => parseCreateBody({ title: 'T', type: 'virtual', startAt: '2026-11-25T10:00:00Z', endAt: '2026-11-25T11:00:00Z', dealId: 'x' })));
    const up = parseUpdateBody({ title: 'New' });
    check('parseUpdateBody leaves absent keys absent', Object.keys(up).join() === 'title', up);
    const oc = parseOutcomeBody({ momText: 'm', nextSteps: [{ action: 'a', dueDate: null }], checkOutAt: { lat: 1, lng: 2, accuracyM: 3 } });
    check('parseOutcomeBody ok', oc.momText === 'm' && oc.checkOutAt?.accuracyM === 3, oc);
    check('parseOutcomeBody rejects bad sentiment', throwsZod(() => parseOutcomeBody({ momText: 'm', sentiment: 'happy' })));
  }

  // UI helpers (My day): tenant-tz datetime conversion, maps link, geolocation messages.
  {
    check('zonedInputToIso IST', zonedInputToIso('2026-11-25T10:00', 'Asia/Kolkata') === '2026-11-25T10:00:00+05:30', zonedInputToIso('2026-11-25T10:00', 'Asia/Kolkata'));
    check('zonedInputToIso UTC', zonedInputToIso('2026-11-25T10:00', 'UTC') === '2026-11-25T10:00:00+00:00');
    check('zonedInputToIso negative offset (NY winter)', zonedInputToIso('2026-01-15T09:30', 'America/New_York') === '2026-01-15T09:30:00-05:00');
    check('zonedInputToIso NY summer', zonedInputToIso('2026-07-15T09:30', 'America/New_York') === '2026-07-15T09:30:00-04:00');
    check('zonedInputToIso Nepal +05:45', zonedInputToIso('2026-11-25T23:59', 'Asia/Kathmandu') === '2026-11-25T23:59:00+05:45');
    check('zonedInputToIso junk -> null', zonedInputToIso('nope', 'Asia/Kolkata') === null);
    check('zonedInputToIso bad day -> null', zonedInputToIso('2026-02-30T10:00', 'Asia/Kolkata') === null);
    const iso = zonedInputToIso('2026-11-25T10:00', 'Asia/Kolkata')!;
    check('zonedInputToIso round-trips to the instant', new Date(iso).toISOString() === '2026-11-25T04:30:00.000Z', iso);
    check('isoToZonedInput IST', isoToZonedInput(new Date('2026-11-25T04:30:00Z'), 'Asia/Kolkata') === '2026-11-25T10:00');
    check('isoToZonedInput crosses midnight', isoToZonedInput('2026-11-25T20:00:00Z', 'Asia/Kolkata') === '2026-11-26T01:30');
    check('todayInTz IST after UTC midnight', todayInTz('Asia/Kolkata', new Date('2026-11-25T19:00:00Z')) === '2026-11-26');
    check('todayInTz UTC', todayInTz('UTC', new Date('2026-11-25T19:00:00Z')) === '2026-11-25');
    check('todayInTz bad tz falls back to IST', todayInTz('Not/AZone', new Date('2026-11-25T19:00:00Z')) === '2026-11-26');
    check('formatTimeInTz IST', formatTimeInTz('2026-11-25T04:30:00Z', 'Asia/Kolkata') === '10:00 am', formatTimeInTz('2026-11-25T04:30:00Z', 'Asia/Kolkata'));
    check('formatTimeInTz pm', formatTimeInTz('2026-11-25T09:45:00Z', 'Asia/Kolkata') === '3:15 pm', formatTimeInTz('2026-11-25T09:45:00Z', 'Asia/Kolkata'));

    check('shiftDate +1 over month end', shiftDate('2026-11-30', 1) === '2026-12-01');
    check('shiftDate -1 over year start', shiftDate('2026-01-01', -1) === '2025-12-31');
    check('isValidDate ok / bad', isValidDate('2026-11-25') && !isValidDate('2026-02-30') && !isValidDate('25-11-2026') && !isValidDate(undefined));

    check('directionsUrl coords', directionsUrl({ lat: 28.5355, lng: 77.391, address: 'Sector 18' }) === 'https://www.google.com/maps/dir/?api=1&destination=28.5355,77.391');
    check('directionsUrl address', directionsUrl({ lat: null, lng: null, address: 'A-12, Sector 62, Noida & Co' }) === 'https://www.google.com/maps/dir/?api=1&destination=A-12%2C%20Sector%2062%2C%20Noida%20%26%20Co');
    check('directionsUrl blank -> null', directionsUrl({ lat: null, lng: null, address: '  ' }) === null);

    check('geoErrorMessage denied', geoErrorMessage(1).includes('Location permission is off'));
    check('geoErrorMessage unavailable', geoErrorMessage(2).includes('could not find your location'));
    check('geoErrorMessage timeout', geoErrorMessage(3).includes('took too long'));
    check('isLowAccuracy 101', isLowAccuracy(101) && !isLowAccuracy(100) && !isLowAccuracy(12));
  }


  // Manager board timeline (Field day): geometry in tenant tz, colours, lane stacking, travel connectors.
  {
    const ist = (hhmm: string) => new Date(`2026-11-25T${hhmm}:00+05:30`);
    const g1 = blockGeometry(ist('09:00'), ist('10:00'), 'Asia/Kolkata');
    check('blockGeometry 09:00-10:00 -> left 0 width 10', g1.leftPct === 0 && g1.widthPct === 10 && !g1.clippedStart && !g1.clippedEnd, g1);
    const g2 = blockGeometry(ist('08:00'), ist('09:30'), 'Asia/Kolkata');
    check('blockGeometry 08:00-09:30 -> clippedStart width 5', g2.leftPct === 0 && g2.widthPct === 5 && g2.clippedStart && !g2.clippedEnd, g2);
    const g3 = blockGeometry(ist('14:00'), ist('15:30'), 'Asia/Kolkata');
    check('blockGeometry 14:00-15:30 -> left 50 width 15', g3.leftPct === 50 && g3.widthPct === 15, g3);
    const g4 = blockGeometry(ist('18:30'), ist('20:00'), 'Asia/Kolkata');
    check('blockGeometry 18:30-20:00 -> clippedEnd', g4.leftPct === 95 && g4.widthPct === 5 && g4.clippedEnd && !g4.clippedStart, g4);
    const g5 = blockGeometry(ist('07:00'), ist('08:00'), 'Asia/Kolkata');
    check('blockGeometry entirely before -> at left edge, clipped', g5.leftPct === 0 && g5.widthPct === 0 && g5.clippedStart, g5);
    const g6 = blockGeometry(ist('20:00'), ist('21:00'), 'Asia/Kolkata');
    check('blockGeometry entirely after -> at right edge, clipped', g6.leftPct === 100 && g6.widthPct === 0 && g6.clippedEnd, g6);
    const g7 = blockGeometry(ist('18:00'), new Date('2026-11-25T19:30:00Z'), 'Asia/Kolkata');
    check('blockGeometry past midnight end stays clipped (not wrapped)', g7.leftPct === 90 && g7.widthPct === 10 && g7.clippedEnd, g7);
    const g8 = blockGeometry(new Date('2026-11-25T09:00:00Z'), new Date('2026-11-25T10:00:00Z'), 'UTC');
    check('blockGeometry uses the given tz', g8.leftPct === 0 && g8.widthPct === 10, g8);
    const g9 = blockGeometry(ist('09:00'), ist('10:00'), 'Asia/Kolkata', 8, 18);
    check('blockGeometry custom day window', g9.leftPct === 10 && g9.widthPct === 10, g9);
    const g10 = blockGeometry(ist('09:00').toISOString(), ist('10:00').toISOString(), 'Asia/Kolkata');
    check('blockGeometry accepts ISO strings', g10.leftPct === 0 && g10.widthPct === 10, g10);

    const noRisk = { reasons: [] as Array<'no_checkin' | 'travel_gap' | 'overlap' | 'mom_missing'>, travelGapMin: null, estDriveMin: null, estimate: false };
    const atRisk = { ...noRisk, reasons: ['overlap' as const] };
    check('blockColor planned', blockColor({ status: 'planned', risk: noRisk }) === 'planned');
    check('blockColor en_route / checked_out -> planned', blockColor({ status: 'en_route', risk: noRisk }) === 'planned' && blockColor({ status: 'checked_out', risk: noRisk }) === 'planned');
    check('blockColor arrived / checked_in -> onsite', blockColor({ status: 'arrived', risk: noRisk }) === 'onsite' && blockColor({ status: 'checked_in', risk: noRisk }) === 'onsite');
    check('blockColor mom_logged -> done', blockColor({ status: 'mom_logged', risk: noRisk }) === 'done');
    check('blockColor at risk wins over planned / onsite / done', (['planned', 'checked_in', 'mom_logged'] as const).every((s) => blockColor({ status: s, risk: atRisk }) === 'atrisk'));

    const item = (id: string, from: string, to: string, extra: Partial<LaneItem> = {}): LaneItem => ({
      id,
      type: 'physical',
      status: 'planned',
      startAt: ist(from),
      endAt: ist(to),
      lat: 28.5,
      lng: 77.3,
      risk: noRisk,
      ...extra,
    });
    const lane = layoutLane([
      item('c', '11:00', '12:00', { risk: { reasons: ['travel_gap'], travelGapMin: 15, estDriveMin: 40, estimate: true } }),
      item('a', '09:00', '10:00'),
      item('b', '09:30', '10:30', { type: 'virtual', lat: null, lng: null }),
      item('x', '09:15', '09:45', { status: 'cancelled' }),
      item('d', '12:00', '13:00', { risk: { reasons: [], travelGapMin: 0, estDriveMin: 5, estimate: false } }),
    ], 'Asia/Kolkata');
    const row = (id: string) => lane.blocks.find((b) => b.meeting.id === id);
    check('layoutLane hides cancelled', !row('x') && lane.blocks.length === 4, lane.blocks.map((b) => b.meeting.id));
    check('layoutLane sorts by start', lane.blocks.map((b) => b.meeting.id).join() === 'a,b,c,d');
    check('layoutLane stacks an overlap in a second row', row('a')?.row === 0 && row('b')?.row === 1 && lane.rows === 2, lane.blocks.map((b) => [b.meeting.id, b.row]));
    check('layoutLane back-to-back stays in row 0', row('c')?.row === 0 && row('d')?.row === 0);
    check('layoutLane flags overlapping blocks only', row('a')?.overlaps === true && row('b')?.overlaps === true && row('c')?.overlaps === false && row('d')?.overlaps === false);
    check('layoutLane connectors join consecutive physical sited blocks', lane.connectors.map((c) => `${c.fromId}>${c.toId}`).join() === 'a>c,c>d', lane.connectors);
    const ac = lane.connectors[0]!;
    check('layoutLane connector carries drive minutes, est. and travel_gap', ac.minutes === 40 && ac.estimate && ac.tight, ac);
    const cd = lane.connectors[1]!;
    check('layoutLane connector without gap is not tight', cd.minutes === 5 && !cd.estimate && !cd.tight, cd);
    check('layoutLane connector geometry spans prev end -> next start', ac.leftPct === 10 && ac.widthPct === 10 && cd.widthPct === 0, [ac.leftPct, ac.widthPct, cd.widthPct]);
    const three = layoutLane([item('p', '09:00', '12:00'), item('q', '10:00', '11:00'), item('r', '11:00', '13:00')], 'Asia/Kolkata');
    check('layoutLane reuses the first free row', three.blocks.map((b) => b.row).join() === '0,1,1' && three.rows === 2, three.blocks.map((b) => b.row));
    const early = layoutLane([item('e1', '07:30', '08:00'), item('e2', '08:15', '08:45')], 'Asia/Kolkata');
    check('layoutLane two pre-09:00 meetings -> different rows, no overlap flag', early.blocks[0]!.row !== early.blocks[1]!.row && early.blocks.every((b) => !b.overlaps) && early.rows === 2, early.blocks.map((b) => [b.row, b.overlaps, b.leftPct, b.widthPct]));
    const late = layoutLane([item('l1', '19:30', '20:00'), item('l2', '20:15', '21:00')], 'Asia/Kolkata');
    check('layoutLane two post-19:00 meetings -> different rows, drawn at right edge', late.blocks[0]!.row !== late.blocks[1]!.row && late.blocks.every((b) => !b.overlaps && b.leftPct + b.widthPct === 100), late.blocks.map((b) => [b.row, b.leftPct, b.widthPct]));
    const short = layoutLane([item('s1', '10:00', '10:10'), item('s2', '10:10', '10:20')], 'Asia/Kolkata');
    check('layoutLane back-to-back 10-min meetings -> different rows, no overlap flag', short.blocks[0]!.row !== short.blocks[1]!.row && short.blocks.every((b) => !b.overlaps), short.blocks.map((b) => [b.row, b.overlaps]));
    check('layoutLane drawn width is at least MIN_BLOCK_PCT', short.blocks.every((b) => b.widthPct === MIN_BLOCK_PCT && b.geometry.widthPct < MIN_BLOCK_PCT), short.blocks.map((b) => b.widthPct));
    const real = layoutLane([item('r1', '10:00', '11:00'), item('r2', '10:30', '11:30')], 'Asia/Kolkata');
    check('layoutLane real overlap still flagged', real.blocks.every((b) => b.overlaps) && real.blocks[0]!.row !== real.blocks[1]!.row);
    check('layoutLane empty', layoutLane([], 'UTC').rows === 1 && layoutLane([], 'UTC').blocks.length === 0);
  }
  {
    const all: MeetingStatus[] = ['planned', 'en_route', 'arrived', 'checked_in', 'checked_out', 'mom_logged', 'cancelled'];
    const cancellable = all.filter(canCancelMeeting);
    check('edit UI: cancel only before check-in', cancellable.join() === 'planned,en_route,arrived', cancellable);
    check('edit UI: edit for any non-cancelled', all.filter(canEditMeeting).length === 6 && !canEditMeeting('cancelled'));
    const g = (s: MeetingStatus) => editGates(s);
    check(
      'edit UI gates mirror the service',
      g('planned').structural && g('en_route').structural && !g('arrived').structural && g('arrived').details &&
        !g('checked_out').structural && g('checked_out').details && !g('mom_logged').details && g('mom_logged').notes &&
        !g('cancelled').notes,
    );
    const base: MeetingFormValues = {
      title: 'Demo',
      type: 'physical',
      date: '2026-12-02',
      startTime: '10:00',
      endTime: '11:00',
      ownerId: 'u1',
      dealId: null,
      companyId: 'c1',
      contactId: null,
      address: 'Site Rd',
      virtualUrl: '',
      notes: '',
    };
    const open = editGates('planned');
    check('patch: unchanged form sends nothing', JSON.stringify(meetingPatch(base, { ...base, title: ' Demo ' }, 'Asia/Kolkata', open)) === '{}');
    const p1 = meetingPatch(base, { ...base, startTime: '12:00', endTime: '12:30', notes: ' hi ' }, 'Asia/Kolkata', open);
    check(
      'patch: changed times and notes only',
      JSON.stringify(p1) === JSON.stringify({ notes: 'hi', startAt: '2026-12-02T12:00:00+05:30', endAt: '2026-12-02T12:30:00+05:30' }),
      p1,
    );
    const p2 = meetingPatch(base, { ...base, companyId: null, address: '' }, 'Asia/Kolkata', open);
    check('patch: cleared company and address are sent as null', JSON.stringify(p2) === '{"companyId":null,"address":null}', p2);
    const late = editGates('checked_in');
    const p3 = meetingPatch(base, { ...base, title: 'New', type: 'virtual', startTime: '09:00' }, 'Asia/Kolkata', late);
    check('patch: structural fields dropped past en_route', JSON.stringify(p3) === '{"title":"New"}', p3);
    let threw = '';
    try {
      meetingPatch(base, { ...base, endTime: '09:00' }, 'Asia/Kolkata', open);
    } catch (e) {
      threw = (e as Error).message;
    }
    check('patch: end before start throws copy', threw === 'End time must be after the start.', threw);
    check(
      'edit error copy for invalid_transition',
      editErrorText({ error: 'Cannot change time once the visit has started', code: 'invalid_transition' }).includes('refresh') &&
        editErrorText({ error: 'Title is required', code: 'validation' }) === 'Title is required',
    );
  }

  // ---- Check-in time window (pure)
  {
    const start = new Date('2026-12-02T06:00:00Z'); // 11:30 IST
    const end = new Date('2026-12-02T07:00:00Z');
    const at = (min: number) => new Date(start.getTime() + min * 60_000);
    const def = checkinWindow({ startAt: start, endAt: end }, { checkinOpensBeforeMin: 120, checkinClosesAfterMin: 240 });
    check('window: opens 120 min before start', def.opensAt.toISOString() === '2026-12-02T04:00:00.000Z', def);
    check('window: closes 240 min after end', def.closesAt.toISOString() === '2026-12-02T11:00:00.000Z', def);
    check('window: before open', checkinWindowState(def, at(-121)) === 'before');
    check('window: at open boundary inclusive', checkinWindowState(def, at(-120)) === 'open');
    check('window: inside', checkinWindowState(def, at(30)) === 'open');
    check('window: at close boundary inclusive', checkinWindowState(def, at(60 + 240)) === 'open');
    check('window: after close', checkinWindowState(def, new Date(at(300).getTime() + 1)) === 'after');
    const custom = checkinWindow({ startAt: start, endAt: end }, { checkinOpensBeforeMin: 15, checkinClosesAfterMin: 30 });
    check('window custom 15/30: 16 min early before, 15 open', checkinWindowState(custom, at(-16)) === 'before' && checkinWindowState(custom, at(-15)) === 'open');
    check('window custom 15/30: 30 after end open, 31 after', checkinWindowState(custom, at(90)) === 'open' && checkinWindowState(custom, at(91)) === 'after');
    const zero = checkinWindow({ startAt: start, endAt: end }, { checkinOpensBeforeMin: 0, checkinClosesAfterMin: 0 });
    check(
      'window 0/0: only during the meeting',
      checkinWindowState(zero, at(-1)) === 'before' &&
        checkinWindowState(zero, at(0)) === 'open' &&
        checkinWindowState(zero, at(60)) === 'open' &&
        checkinWindowState(zero, at(61)) === 'after',
    );
    const tz = 'Asia/Kolkata';
    check('gate label before: opens at 9:30 am', checkinGateLabel(def.opensAt.toISOString(), def.closesAt.toISOString(), at(-180), tz) === 'Check-in opens at 9:30 am', checkinGateLabel(def.opensAt, def.closesAt, at(-180), tz));
    check('gate label after: closed at 4:30 pm', checkinGateLabel(def.opensAt, def.closesAt, at(400), tz) === 'Check-in closed at 4:30 pm', checkinGateLabel(def.opensAt, def.closesAt, at(400), tz));
    check('gate label inside: null', checkinGateLabel(def.opensAt, def.closesAt, at(0), tz) === null);
    check('gate label missing window: null', checkinGateLabel(undefined, undefined, at(0), tz) === null);
  }

  // --- meeting form pickers: linking (applyPick) and address vs company site
  {
    const co = (id: string, name: string, over: Partial<Parameters<typeof toPickerCompany>[0]> = {}) =>
      toPickerCompany({ id, name, address: `${name} Rd`, city: 'Noida', state: 'UP', postalCode: '201301', lat: 28.5, lng: 77.3, geocodeStatus: 'manual', ...over });
    const A = co('a', 'Acme');
    const B = co('b', 'Bolt', { lat: null, lng: null, geocodeStatus: 'pending' });
    const companyA: PickerChoice = { id: 'a', label: 'Acme', companyId: 'a', company: A };
    const companyB: PickerChoice = { id: 'b', label: 'Bolt', companyId: 'b', company: B };
    const contactA: PickerChoice = { id: 'ka', label: 'Kim', companyId: 'a', company: A };
    const contactB: PickerChoice = { id: 'kb', label: 'Bo', companyId: 'b', company: B };
    const dealB: PickerChoice = { id: 'db', label: 'Bolt deal', companyId: 'b', company: B, contact: contactB };
    const dealA: PickerChoice = { id: 'da', label: 'Acme deal', companyId: 'a', company: A, contact: null };
    const none: Links = { deal: null, company: null, contact: null };

    const r1 = applyPick(none, 'deal', dealB);
    check(
      'pick deal fills its company and contact',
      r1.links.company?.id === 'b' && r1.links.contact?.id === 'kb' && r1.companyChanged && r1.notice === null,
      r1,
    );
    const r2 = applyPick({ deal: null, company: companyA, contact: contactA }, 'deal', dealB);
    check(
      'pick deal replaces a different company, with a notice',
      r2.links.company?.id === 'b' && r2.links.contact?.id === 'kb' && r2.companyChanged && /Company changed to Bolt/.test(r2.notice ?? ''),
      r2,
    );
    const r3 = applyPick({ deal: null, company: null, contact: contactB }, 'deal', dealA);
    check('pick deal without contact clears a contact from another company', r3.links.contact === null && r3.links.company?.id === 'a', r3);
    const r4 = applyPick({ deal: dealB, company: companyB, contact: contactB }, 'company', companyA);
    check(
      'pick company clears a foreign contact and deal',
      r4.links.company?.id === 'a' && r4.links.contact === null && r4.links.deal === null && r4.companyChanged && !!r4.notice,
      r4,
    );
    const r5 = applyPick({ deal: dealA, company: null, contact: contactA }, 'company', companyA);
    check('pick company keeps its own contact and deal', r5.links.deal?.id === 'da' && r5.links.contact?.id === 'ka' && r5.notice === null, r5);
    const r6 = applyPick(none, 'contact', contactA);
    check('pick contact fills an empty company', r6.links.company?.id === 'a' && r6.companyChanged, r6);
    const r7 = applyPick({ ...none, company: companyB }, 'contact', contactA);
    check('pick contact keeps a chosen company', r7.links.company?.id === 'b' && !r7.companyChanged, r7);
    const r8 = applyPick({ deal: dealA, company: companyA, contact: contactA }, 'company', null);
    check('clear company keeps deal and contact, flags the change', r8.links.company === null && r8.links.deal?.id === 'da' && r8.companyChanged, r8);
    const r9 = applyPick({ deal: dealA, company: companyA, contact: null }, 'deal', null);
    check('clear deal changes nothing else', r9.links.company?.id === 'a' && !r9.companyChanged, r9);

    const block = { address: 'Acme Rd', city: 'Noida', state: 'UP', postalCode: '201301' };
    const line = companyGeocodeLine(block)!;
    check('company line', line === 'Acme Rd, Noida, UP, 201301', line);
    check(
      'isCompanyAddress: blank, full line (trimmed), street line yes; other no; no company no',
      isCompanyAddress(null, block) &&
        isCompanyAddress('  ', block) &&
        isCompanyAddress(` ${line} `, block) &&
        isCompanyAddress('Acme Rd', block) &&
        !isCompanyAddress('Acme Rd, Gate 2', block) &&
        !isCompanyAddress('x', null),
    );
    check('sameAsCompany mirrors isCompanyAddress', sameAsCompany(line, A) && sameAsCompany('', A) && !sameAsCompany('Gate 2', A));
    check('siteCheck pinned company', siteCheck(line, A).text === 'Checked against: company site (pinned)', siteCheck(line, A));
    check(
      'siteCheck located / not located yet',
      siteCheck('', { ...A, geocodeStatus: 'ok' }).text === 'Checked against: company site (located)' &&
        siteCheck(B.siteLine!, B).text === 'Checked against: company site (not located yet)',
    );
    const own = siteCheck('Gate 2, Sector 63', A);
    check('siteCheck own address', own.kind === 'own' && own.text === 'This meeting will be checked against this address instead of the company site.', own);
    check('siteCheck without company: nothing to say', siteCheck('Gate 2', null).kind === 'none');

    check('parsePickerQuery ok', parsePickerQuery(new URLSearchParams('kind=deal&q=ac')).kind === 'deal');
    const bad = (qs: string) => {
      try {
        parsePickerQuery(new URLSearchParams(qs));
        return false;
      } catch (e) {
        return e instanceof ZodError;
      }
    };
    check('parsePickerQuery rejects bad kind / companyId', bad('kind=task') && bad('kind=deal&companyId=nope') && bad(''));
  }

  // --- late check-in (lateBy)
  {
    const start = new Date('2026-12-02T05:00:00Z');
    const at = (min: number) => new Date(start.getTime() + min * 60_000);
    const m = { type: 'physical' as const, source: 'manual', startAt: start };
    check('lateBy inside grace → null', lateBy(m, at(10), 15) === null);
    check('lateBy start+16, grace 15 → 16', lateBy(m, at(16), 15) === 16, lateBy(m, at(16), 15));
    check('lateBy exactly start+grace → null', lateBy(m, at(15), 15) === null);
    check('lateBy early → null', lateBy(m, at(-30), 15) === null);
    check('lateBy walk-in → null', lateBy({ ...m, source: 'walk_in' }, at(90), 15) === null);
    check('lateBy virtual → null', lateBy({ ...m, type: 'virtual' }, at(90), 15) === null);
    check('lateBy not checked in → null', lateBy(m, null, 15) === null);
    check('lateBy ISO strings, grace 0', lateBy({ ...m, startAt: start.toISOString() }, at(1).toISOString(), 0) === 1);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nfield selftest: ${passed} passed, ${results.length - passed} failed`);
  process.exit(exitCode);
}
void main();
