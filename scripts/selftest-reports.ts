/**
 * Pure self-test for the manager reports (build prompt 3). No database.
 * Expected values are worked out by hand in the comments, NOT derived from
 * the code under test.
 *
 *   tsx scripts/selftest-reports.ts
 */
import { METRICS, costPer, metricValue, sourceRoi } from '../src/lib/reports/metrics';
import { csvField, csvLine } from '../src/lib/reports/manager/csv-format';
import { renderDigestHtml, renderDigestShort, type DigestData } from '../src/lib/reports/manager/digest-render';
import { bandVsMedian, computeFunnel, delta, emptyCounters, maxFunnelRank, median, percentile, sumCounters, topMovers, type FactCounters, type FunnelLead } from '../src/lib/reports/manager/math';
import { collectPacketNumbers, depseudonymise, extractNumbers, findPii } from '../src/lib/reports/manager/narrative-guard';
import { buildFactsPacket, buildNarrativeRequest, checkModelOutput } from '../src/lib/reports/manager/narrative-packet';
import { addDays, compareRange, dayStartUtc, localDay, localWeekdayHour, planSegments, resolveRange, weekStart } from '../src/lib/reports/manager/time';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
const eq = (name: string, a: unknown, e: unknown) => check(name, JSON.stringify(a) === JSON.stringify(e), { actual: a, expected: e });

const row = (p: Partial<FactCounters> & { ownerId: string; sourceId?: string | null; day?: string }) => ({
  ...emptyCounters(),
  day: p.day ?? '2026-11-10',
  sourceId: p.sourceId ?? null,
  medianFirstResponseSec: null,
  ...p,
});

/* ---------------------------------------------------------------- metrics
 * 10-lead fixture over 2 days, 2 reps (A, B):
 *   A: 6 leads, won 2 (₹1,00,000 + ₹50,000), lost 1, 20 calls / 8 connected / 1800 s talk, 30 activities
 *   B: 4 leads, won 1 (₹30,000), lost 2, 10 calls / 5 connected / 600 s talk, 12 activities
 * Hand-computed:
 *   lead_volume = 10; won_value = 180000; won_count = 3
 *   win_rate = 3 / (3 + 3) = 50%
 *   avg_deal_value = 180000 / 3 = 60000
 *   contact_rate = 13 / 30 = 43.33… → 43.3%
 *   talk_time = 2400 s = 40 min
 *   activities_per_rep_per_day = 42 / 2 reps / 2 days = 10.5
 */
{
  const rows = [
    row({ ownerId: 'A', day: '2026-11-10', leadsCreated: 4, wonCount: 1, wonValue: 100000, callsMade: 12, callsConnected: 5, talkTimeSec: 1200, activities: 18 }),
    row({ ownerId: 'A', day: '2026-11-11', leadsCreated: 2, wonCount: 1, wonValue: 50000, lostCount: 1, callsMade: 8, callsConnected: 3, talkTimeSec: 600, activities: 12 }),
    row({ ownerId: 'B', day: '2026-11-10', leadsCreated: 3, lostCount: 2, callsMade: 6, callsConnected: 3, talkTimeSec: 400, activities: 7 }),
    row({ ownerId: 'B', day: '2026-11-11', leadsCreated: 1, wonCount: 1, wonValue: 30000, callsMade: 4, callsConnected: 2, talkTimeSec: 200, activities: 5 }),
  ];
  const t = sumCounters(rows);
  const ctx = { reps: 2, days: 2 };
  eq('lead_volume', metricValue('lead_volume', t, ctx), 10);
  eq('won_value', metricValue('won_value', t, ctx), 180000);
  eq('won_count', metricValue('won_count', t, ctx), 3);
  eq('win_rate', metricValue('win_rate', t, ctx), 50);
  eq('avg_deal_value', metricValue('avg_deal_value', t, ctx), 60000);
  eq('contact_rate', metricValue('contact_rate', t, ctx), 43.3);
  eq('talk_time minutes', metricValue('talk_time', t, ctx), 40);
  eq('activities per rep per day', metricValue('activities_per_rep_per_day', t, ctx), 10.5);
  eq('win_rate with no closed deals is null, not 0', metricValue('win_rate', emptyCounters(), ctx), null);
  eq('live metric has no rollup value', metricValue('sla_compliance_pct', t, ctx), null);
  eq('every metric has a label + unit', Object.values(METRICS).every((m) => m.label && m.unit && m.description), true);
  // ROI: won 180000 on spend 45000 → 4×; cost per lead 45000/10 = 4500; cost per won 15000.
  eq('source roi', sourceRoi(180000, 45000), 4);
  eq('cost per lead', costPer(45000, 10), 4500);
  eq('cost per won', costPer(45000, 3), 15000);
  eq('roi with no spend is null', sourceRoi(1000, 0), null);
  // delta: 12 vs 8 → +4, +50%; vs 0 → percent null
  eq('delta', delta(12, 8), { current: 12, previous: 8, absolute: 4, percent: 50 });
  eq('delta from zero', delta(5, 0).percent, null);
  // percentile_cont semantics: [1,2,3,4] p90 = 3 + 0.7 × (4 − 3) = 3.7; median = 2.5
  eq('p90', percentile([4, 1, 3, 2], 90), 3.7);
  eq('median even', median([4, 1, 3, 2]), 2.5);
  eq('median empty', median([]), null);
  eq('band well above', bandVsMedian(30, 20), 2);
  eq('band slightly below', bandVsMedian(16, 20), -1);
  eq('band lower-is-better inverts', bandVsMedian(10, 20, false), 2);
  const movers = topMovers([
    { key: 'a', label: 'A', current: 10, previous: 2 },
    { key: 'b', label: 'B', current: 3, previous: 9 },
    { key: 'c', label: 'C', current: 5, previous: 5 },
  ]);
  eq('top movers by |change|, unchanged dropped', movers.map((m) => m.key), ['a', 'b']);
}

/* ----------------------------------------------------------------- funnel
 * L1 lead only | L2 lead→qualified | L3 lead→proposal (skips qualified)
 * L4 lead→qualified→proposal→qualified (regresses) | L5 lead→qualified→qualified (re-enters)
 * L6 …→won | L7 lead→lost | L8 hold only | L9 …→negotiation | L10 no history
 * Reached (stage or later): lead 10; qualified L2 L3 L4 L5 L6 L9 = 6;
 *   proposal L3 L4 L6 L9 = 4; negotiation L6 L9 = 2; won L6 = 1.
 * Step %: 60, 66.7, 50, 50. Cohort %: 100, 60, 40, 20, 10.
 * Median days from previous stage (only where both first-entered times exist):
 *   qualified: L2 2, L4 4, L6 1, L9 1 → 1.5 | proposal: L4 1, L6 2, L9 1 → 1
 *   negotiation: L6 1, L9 8 → 4.5 | won: L6 5 → 5
 */
{
  const d = (n: number) => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`;
  const leads: FunnelLead[] = [
    { dealId: 'L1', stagesEntered: ['lead'] },
    { dealId: 'L2', stagesEntered: ['lead', 'qualified'], firstEnteredAt: { lead: d(1), qualified: d(3) } },
    { dealId: 'L3', stagesEntered: ['lead', 'proposal'], firstEnteredAt: { lead: d(1), proposal: d(2) } },
    { dealId: 'L4', stagesEntered: ['lead', 'qualified', 'proposal', 'qualified'], firstEnteredAt: { lead: d(1), qualified: d(5), proposal: d(6) } },
    { dealId: 'L5', stagesEntered: ['lead', 'qualified', 'qualified'] },
    { dealId: 'L6', stagesEntered: ['lead', 'qualified', 'proposal', 'negotiation', 'won'], firstEnteredAt: { lead: d(1), qualified: d(2), proposal: d(4), negotiation: d(5), won: d(10) } },
    { dealId: 'L7', stagesEntered: ['lead', 'lost'] },
    { dealId: 'L8', stagesEntered: ['hold'] },
    { dealId: 'L9', stagesEntered: ['lead', 'qualified', 'proposal', 'negotiation'], firstEnteredAt: { lead: d(1), qualified: d(2), proposal: d(3), negotiation: d(11) } },
    { dealId: 'L10', stagesEntered: [] },
  ];
  const f = computeFunnel(leads);
  eq('funnel counts', f.map((s) => s.count), [10, 6, 4, 2, 1]);
  eq('funnel step %', f.map((s) => s.stepConversionPct), [null, 60, 66.7, 50, 50]);
  eq('funnel cohort %', f.map((s) => s.cohortPct), [100, 60, 40, 20, 10]);
  eq('funnel median days', f.map((s) => s.medianDaysFromPrevious), [null, 1.5, 1, 4.5, 5]);
  eq('skipped stage still reaches proposal', maxFunnelRank(['lead', 'proposal']), 2);
  eq('regression keeps furthest stage', maxFunnelRank(['proposal', 'qualified']), 2);
  eq('lost-only lead is a lead', maxFunnelRank(['lost']), 0);
  eq('every step ≤ previous', f.every((s, i) => i === 0 || s.count <= f[i - 1]!.count), true);
  eq('empty cohort', computeFunnel([]).map((s) => s.count), [0, 0, 0, 0, 0]);
}

/* ------------------------------------------------------- IST day buckets */
{
  const tz = 'Asia/Kolkata';
  // 23:50 IST on 14 Nov = 18:20Z; 00:10 IST on 15 Nov = 18:40Z.
  eq('23:50 IST lands on the 14th', localDay(new Date('2026-11-14T18:20:00Z'), tz), '2026-11-14');
  eq('00:10 IST lands on the 15th', localDay(new Date('2026-11-14T18:40:00Z'), tz), '2026-11-15');
  eq('same instants in UTC are one day', localDay(new Date('2026-11-14T18:40:00Z'), 'UTC'), '2026-11-14');
  eq('IST day starts 18:30Z the day before', dayStartUtc('2026-11-15', tz).toISOString(), '2026-11-14T18:30:00.000Z');
  eq('weekday/hour in IST', localWeekdayHour(new Date('2026-11-16T03:30:00Z'), tz), { weekday: 1, hour: 9 });
  eq('week start (Mon)', weekStart('2026-11-15'), '2026-11-09');
  eq('add days over month end', addDays('2026-01-31', 1), '2026-02-01');

  const now = new Date('2026-11-14T10:00:00Z'); // 15:30 IST, Saturday
  const r7 = resolveRange({ preset: '7d', tz, now });
  eq('7d range', [r7.fromDay, r7.toDay, r7.days, r7.fromTs.toISOString(), r7.toTs.toISOString()], ['2026-11-08', '2026-11-14', 7, '2026-11-07T18:30:00.000Z', '2026-11-14T18:30:00.000Z']);
  const p7 = compareRange(r7, 'previous')!;
  eq('7d previous', [p7.fromDay, p7.toDay], ['2026-11-01', '2026-11-07']);
  const y7 = compareRange(r7, 'yoy')!;
  eq('7d yoy', [y7.fromDay, y7.toDay], ['2025-11-08', '2025-11-14']);
  const mtd = resolveRange({ preset: 'mtd', tz, now });
  eq('mtd', [mtd.fromDay, mtd.toDay, mtd.days], ['2026-11-01', '2026-11-14', 14]);
  const pm = compareRange(mtd, 'previous')!;
  eq('mtd previous = same days of last month', [pm.fromDay, pm.toDay], ['2026-10-01', '2026-10-14']);
  const today = resolveRange({ preset: 'today', tz, now });
  eq('today', [today.fromDay, today.toDay], ['2026-11-14', '2026-11-14']);
  const custom = resolveRange({ preset: 'custom', from: '2026-11-10', to: '2026-11-01', tz, now });
  eq('custom swaps reversed dates', [custom.fromDay, custom.toDay], ['2026-11-01', '2026-11-10']);
  eq('custom clamps to 366 days', resolveRange({ preset: 'custom', from: '2020-01-01', to: '2026-11-14', tz, now }).days, 366);
  eq('bad tz falls back to IST', resolveRange({ preset: 'today', tz: 'Mars/Base', now }).tz, tz);

  eq('segments: covered middle', planSegments('2026-09-25', '2026-11-14', '2026-10-01', '2026-11-14'), [
    { from: '2026-09-25', to: '2026-09-30', source: 'live' },
    { from: '2026-10-01', to: '2026-11-13', source: 'rollup' },
    { from: '2026-11-14', to: '2026-11-14', source: 'live' },
  ]);
  eq('segments: no backfill = all live', planSegments('2026-11-01', '2026-11-14', null, '2026-11-14'), [{ from: '2026-11-01', to: '2026-11-14', source: 'live' }]);
  eq('segments: today only = live', planSegments('2026-11-14', '2026-11-14', '2025-01-01', '2026-11-14'), [{ from: '2026-11-14', to: '2026-11-14', source: 'live' }]);
  eq('segments: fully in the past = rollup', planSegments('2026-10-01', '2026-10-31', '2025-01-01', '2026-11-14'), [{ from: '2026-10-01', to: '2026-10-31', source: 'rollup' }]);
}

/* ------------------------------------------- narrative guard + no-PII */
{
  const tz = 'Asia/Kolkata';
  const now = new Date('2026-11-14T10:00:00Z');
  const range = resolveRange({ preset: '7d', tz, now });
  const compare = compareRange(range, 'previous')!;
  const cur = { rows: [row({ ownerId: 'usr_alice', sourceId: 'src-1', leadsCreated: 40, wonCount: 4, wonValue: 200000, callsMade: 120, callsConnected: 48 }), row({ ownerId: 'usr_bob', leadsCreated: 12, wonCount: 1, wonValue: 30000, callsMade: 30, callsConnected: 9 })] };
  const prev = { rows: [row({ ownerId: 'usr_alice', sourceId: 'src-1', leadsCreated: 30, wonCount: 2, wonValue: 90000, callsMade: 100, callsConnected: 45 }), row({ ownerId: 'usr_bob', leadsCreated: 15, wonCount: 2, wonValue: 60000, callsMade: 40, callsConnected: 16 })] };
  const { packet, pseudonyms } = buildFactsPacket({
    range,
    compare,
    cur,
    prev,
    reps: 2,
    sla: { cur: { compliancePct: 82.5, due: 40 }, prev: { compliancePct: 90, due: 35 } },
    sourceNames: new Map([['src-1', 'IndiaMART']]),
  });
  eq('reps pseudonymised in a stable order', [...pseudonyms.values()], ['Rep 1', 'Rep 2']);
  const leadVol = packet.metrics.find((m) => m.metric === 'lead_volume')!;
  // 40 + 12 = 52 vs 30 + 15 = 45 → +7, +15.6%
  eq('packet lead volume', [leadVol.current, leadVol.previous, leadVol.change, leadVol.change_pct], [52, 45, 7, 15.6]);

  // No PII may reach the model: not the rep ids/names/emails, not lead details.
  const sensitive = ['usr_alice', 'usr_bob', 'Alice Sharma', 'alice@acme.in', 'Bob Mehta', 'Ravi Kumar', '+919876543210', 'ravi@castings.in'];
  eq('facts packet has no PII', findPii(packet, sensitive), []);
  const outbound = JSON.stringify(buildNarrativeRequest(packet));
  eq('outbound request contains none of the sensitive strings', sensitive.filter((s) => outbound.toLowerCase().includes(s.toLowerCase())), []);
  eq('outbound request has no email-like or phone-like text', findPii(JSON.parse(outbound)).length, 0);
  check('outbound request uses claude-sonnet-5-5', outbound.includes('"model":"claude-sonnet-5-5"'));
  eq('PII detector catches an email', findPii({ note: 'mail ravi@castings.in' }).length, 1);
  eq('PII detector catches a phone', findPii({ note: 'call +91 98765 43210' }).length, 1);
  eq('PII detector ignores ISO dates', findPii({ from: '2026-11-08', at: '2026-11-08T18:30:00.000Z' }).length, 0);

  const good = {
    headline: 'Leads up 15.6% while won value is likely helped by Rep 1',
    whats_up: ['Leads rose from 45 to 52.'],
    whats_down: ['SLA met fell from 90 to 82.5.'],
    likely_drivers: ['Source: IndiaMART likely drove more leads.'],
    actions_for_manager: [{ action: 'Review response times with Rep 2.', metric: 'calls_made' }],
    caveats: ['Rep 2 sample is small.'],
  };
  const ok = checkModelOutput(JSON.stringify(good), packet);
  eq('grounded narrative accepted', ok.ok, true);
  const invented = checkModelOutput(JSON.stringify({ ...good, whats_up: ['Won value hit 999999 this week.'] }), packet);
  check('narrative with a number absent from the packet is rejected', !invented.ok && invented.reason.startsWith('numbers'), invented);
  const badJson = checkModelOutput('not json', packet);
  check('invalid JSON rejected', !badJson.ok);
  const badShape = checkModelOutput(JSON.stringify({ headline: 'x' }), packet);
  check('wrong shape rejected', !badShape.ok && badShape.reason.startsWith('schema'));
  const badMetric = checkModelOutput(JSON.stringify({ ...good, actions_for_manager: [{ action: 'Do it', metric: 'made_up_metric' }] }), packet);
  check('action tied to unknown metric rejected', !badMetric.ok);
  const tooMany = checkModelOutput(JSON.stringify({ ...good, actions_for_manager: Array(4).fill(good.actions_for_manager[0]) }), packet);
  check('more than 3 actions rejected', !tooMany.ok);
  eq('numbers in text', extractNumbers('From 1,240 to -12.5 in 3 days'), [1240, -12.5, 3]);
  check('packet numbers include dates', collectPacketNumbers(packet).includes(2026));
  if (ok.ok) {
    const named = depseudonymise(ok.narrative, { 'Rep 1': 'Alice Sharma', 'Rep 2': 'Bob Mehta' });
    check('names restored after validation', named.headline.includes('Alice Sharma') && named.actions_for_manager[0]!.action.includes('Bob Mehta'));
  }
}

/* ----------------------------------------------------- digest + CSV */
{
  const data: DigestData = {
    title: 'Daily sales digest',
    workspaceName: 'Acme <script>alert(1)</script>',
    periodLabel: '2026-11-13',
    tiles: [
      { label: 'Leads', value: '52', change: '+7 (+15.6%)', direction: 'up', good: true },
      { label: 'SLA met', value: '82.5%', change: '−7.5', direction: 'down', good: false },
    ],
    tables: [{ title: 'Reps', headers: ['Rep', 'Won'], rows: [{ cells: ['Alice & Co', '4'] }] }],
    actions: ['Call back the 3 oldest leads'],
    link: 'https://app.example/dashboard/insights',
    unsubscribeLink: 'https://app.example/dashboard/settings/digests',
  };
  const html = renderDigestHtml(data);
  check('digest escapes HTML', !html.includes('<script>') && html.includes('&lt;script&gt;') && html.includes('Alice &amp; Co'));
  check('digest has no images or remote styles', !/<img|<link|url\(/i.test(html));
  check('digest change uses arrow + word, not colour alone', html.includes('▲ +7 (+15.6%) (better)') && html.includes('▼ −7.5 (worse)'));
  check('digest only links to our own pages', (html.match(/href="([^"]+)"/g) ?? []).every((h) => h.includes('app.example')));
  check('short digest ≤ 5 lines', renderDigestShort(data).split('\n').length <= 5);

  eq('csv neutralises formulas', csvField('=SUM(A1)'), "'=SUM(A1)");
  eq('csv neutralises @', csvField('@cmd'), "'@cmd");
  eq('csv leaves negative numbers alone', csvField(-5), '-5');
  eq('csv quotes commas and quotes', csvField('a,"b"'), '"a,""b"""');
  eq('csv line', csvLine(['x', null, 3]), 'x,,3\n');
}

console.log(`reports selftest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
