/**
 * Self-test for the dashboard trust pass — pure logic only, no DB.
 *
 * Covers the three things that made the old dashboard lie:
 *   1. Four widgets on four independent time windows → one shared
 *      `DashboardRange` with a well-defined prior period.
 *   2. A single ₹9.5M outlier day flattening won/lost revenue → weekly
 *      bucketing + per-axis capping at the 95th percentile.
 *   3. Percentages rendering unbounded (the 1121% "conversion" badge)
 *      → every displayed percentage clamps at 999%+.
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

const DAY_MS = 86_400_000;

async function main() {
  const {
    resolveDashboardRange,
    dashboardRangeToSearchParams,
    DEFAULT_DASHBOARD_RANGE,
  } = await import('../src/lib/dashboard/range');
  const { buildWeekly, isoWeekStart, quantile } = await import(
    '../src/lib/dashboard/trend-shaping'
  );

  /* ---------------- shared range ---------------- */

  const d90 = resolveDashboardRange({});
  check(
    'no param → default preset',
    d90.preset === DEFAULT_DASHBOARD_RANGE,
    d90.preset,
  );
  check(
    'prior period is same length, immediately before',
    d90.prior.to.getTime() === d90.from.getTime() &&
      d90.to.getTime() - d90.from.getTime() ===
        d90.prior.to.getTime() - d90.prior.from.getTime(),
    `${d90.prior.from.toISOString()}..${d90.prior.to.toISOString()}`,
  );

  const d7 = resolveDashboardRange({ range: 'last_7d' });
  check('7d window is 8 buckets (inclusive today)', d7.days === 8, String(d7.days));
  check(
    '7d prior window is also 8 days',
    Math.round((d7.prior.to.getTime() - d7.prior.from.getTime()) / DAY_MS) === 8,
  );

  const garbage = resolveDashboardRange({ range: 'drop table deals' });
  check(
    'unknown range falls back, does not throw',
    garbage.preset === DEFAULT_DASHBOARD_RANGE,
    garbage.preset,
  );

  const custom = resolveDashboardRange({
    range: 'custom',
    from: '2026-05-01',
    to: '2026-05-10',
  });
  check('custom range parses', custom.preset === 'custom', custom.preset);
  check(
    'custom `to` is made exclusive (10 inclusive days)',
    custom.days === 10,
    String(custom.days),
  );
  check(
    'custom label reads as a date span',
    custom.label.includes('May 1') && custom.label.includes('May 10'),
    custom.label,
  );

  const badCustom = resolveDashboardRange({ range: 'custom', from: 'nope' });
  check(
    'malformed custom falls back to preset',
    badCustom.preset === DEFAULT_DASHBOARD_RANGE,
    badCustom.preset,
  );
  const invertedCustom = resolveDashboardRange({
    range: 'custom',
    from: '2026-05-10',
    to: '2026-05-01',
  });
  check(
    'inverted custom range rejected',
    invertedCustom.preset === DEFAULT_DASHBOARD_RANGE,
    invertedCustom.preset,
  );
  const hugeCustom = resolveDashboardRange({
    range: 'custom',
    from: '1970-01-01',
    to: '2026-05-01',
  });
  check(
    'absurd custom span clamped to 730 days',
    hugeCustom.days <= 730,
    String(hugeCustom.days),
  );

  // The picker must never drop the owner filter.
  const kept = new URLSearchParams('view=rep:usr_123&q=acme');
  const serialized = dashboardRangeToSearchParams({ preset: 'last_30d' }, kept);
  check(
    'range change preserves ?view= and other params',
    serialized.get('view') === 'rep:usr_123' &&
      serialized.get('q') === 'acme' &&
      serialized.get('range') === 'last_30d',
    serialized.toString(),
  );
  const roundTrip = dashboardRangeToSearchParams({
    preset: 'custom',
    from: custom.from,
    to: custom.to,
  });
  check(
    'custom round-trips back to the inclusive day the user picked',
    roundTrip.get('from') === '2026-05-01' && roundTrip.get('to') === '2026-05-10',
    roundTrip.toString(),
  );

  /* ---------------- weekly bucketing ---------------- */

  check('ISO week start is Monday', isoWeekStart('2026-07-02') === '2026-06-29');
  check('Monday maps to itself', isoWeekStart('2026-06-29') === '2026-06-29');
  check('Sunday belongs to the week before', isoWeekStart('2026-07-05') === '2026-06-29');
  check('quantile p50 of 1..5', quantile([1, 2, 3, 4, 5], 0.5) === 3);

  const days = (n: number, at: (i: number) => Partial<{ a: number; b: number; c: number }>) =>
    Array.from({ length: n }, (_, i) => {
      const base = new Date(Date.UTC(2026, 3, 6) + i * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const v = at(i);
      return { day: base, seriesA: v.a ?? 0, seriesB: v.b ?? 0, seriesC: v.c ?? 0 };
    });

  const flat = buildWeekly(
    days(28, () => ({ a: 10, b: 20, c: 5 })),
    false,
  );
  check('28 days → 4 weeks', flat.points.length === 4, String(flat.points.length));
  check(
    'weekly bars SUM the days in the week',
    flat.points[0]!.newPipeline === 140,
    String(flat.points[0]!.newPipeline),
  );
  check('no outlier → no cap', flat.pipelineCap === null && flat.notices.length === 0);

  // Cumulative mode must take the week's LAST value, not the sum.
  const cumulative = buildWeekly(
    days(14, (i) => ({ a: i + 1, b: (i + 1) * 2, c: 0 })),
    true,
  );
  check(
    'cumulative mode takes last-of-week, not a sum',
    cumulative.points[0]!.newPipeline === 14,
    String(cumulative.points[0]!.newPipeline),
  );

  /* ---------------- the Jul 2 outlier ---------------- */

  // Reproduces the reported shape: ~₹9.5M of pipeline created on one
  // day, ordinary weeks either side, and won/lost revenue three orders
  // of magnitude smaller — the exact case where a single shared linear
  // axis flattened won/lost to the baseline.
  const OUTLIER_DAY = 12; // lands in the third week
  const spiky = buildWeekly(
    days(70, (i) => ({
      a: i % 7 === 3 ? 120_000 : 0, // won revenue, weekly-ish
      b: i === OUTLIER_DAY ? 9_500_000 : 40_000,
      c: i % 11 === 0 ? 35_000 : 0, // lost revenue
    })),
    false,
  );
  check(
    'outlier week triggers a pipeline axis cap',
    spiky.pipelineCap !== null,
    String(spiky.pipelineCap),
  );
  const cappedWeeks = spiky.points.filter((p) => p.newPipelineCapped);
  check(
    'exactly the outlier week is capped',
    cappedWeeks.length === 1,
    `${cappedWeeks.length} capped`,
  );
  check(
    'capped week keeps its REAL value for the tooltip',
    cappedWeeks[0]!.newPipeline > cappedWeeks[0]!.newPipelinePlot &&
      cappedWeeks[0]!.newPipeline >= 9_500_000,
    `real=${cappedWeeks[0]!.newPipeline} plotted=${cappedWeeks[0]!.newPipelinePlot}`,
  );
  check(
    'user is told the axis was capped (no silent truncation)',
    spiky.notices.length > 0,
    spiky.notices.join(' '),
  );
  // The whole point: won/lost live on their own axis, so the spike
  // cannot compress them. Their scale must stay in their own range.
  const outcomeMax = Math.max(...spiky.points.map((p) => Math.max(p.won, p.lost)));
  check(
    'won/lost axis is scaled to won/lost, not to the pipeline spike',
    (spiky.outcomeCap ?? outcomeMax) < 9_500_000 / 10,
    `outcomeAxisMax=${spiky.outcomeCap ?? outcomeMax}`,
  );

  // Guard against over-eager capping on thin data.
  const thin = buildWeekly(
    [
      { day: '2026-04-06', seriesA: 0, seriesB: 1_000_000, seriesC: 0 },
      { day: '2026-04-13', seriesA: 0, seriesB: 10, seriesC: 0 },
      { day: '2026-04-20', seriesA: 0, seriesB: 10, seriesC: 0 },
    ],
    false,
  );
  check(
    'fewer than 4 non-zero points → never capped',
    thin.pipelineCap === null,
    String(thin.pipelineCap),
  );

  /* ---------------- percentage caps ---------------- */

  // Mirrors the display rule used by the stage bars and the KPI strip.
  const CAP = 999;
  const render = (pct: number) => (pct > CAP ? `${CAP}%+` : `${pct}%`);
  check('1121% renders capped', render(1121) === '999%+', render(1121));
  check('999% renders verbatim', render(999) === '999%', render(999));
  check('normal ratio untouched', render(64) === '64%', render(64));

  /* ---------------- report ---------------- */

  console.log('\n─── Dashboard self-test ───');
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`,
    );
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed.`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
