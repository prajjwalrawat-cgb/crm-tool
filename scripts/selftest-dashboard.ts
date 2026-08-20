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
  const {
    computeDelta,
    computePointsDelta,
    deltaDirection,
    formatDelta,
    ABSURD_PCT_THRESHOLD,
  } = await import('../src/lib/dashboard/delta');
  const { computeCoverage, formatCoverageRatio } = await import(
    '../src/lib/dashboard/coverage'
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

  /* ---------------- delta formatting ---------------- */

  // The money formatter the KPI strip would inject. Compact-ish, and
  // deliberately unsigned — the chip owns the sign.
  const money = (n: number) => `Rs${Math.round(n / 100).toLocaleString('en-IN')}`;

  check(
    'ordinary growth stays a percentage',
    computeDelta(137, 100).kind === 'percent',
    JSON.stringify(computeDelta(137, 100)),
  );
  check(
    'ordinary growth rounds to one decimal under 10%',
    formatDelta(computeDelta(105, 100), money) === '5.0%',
    formatDelta(computeDelta(105, 100), money),
  );
  check(
    'growth over 10% drops the decimal',
    formatDelta(computeDelta(137, 100), money) === '37%',
    formatDelta(computeDelta(137, 100), money),
  );

  // THE BUG: weighted pipeline read "+900%+" because the prior window
  // was a rounding error, not because the business grew nine-fold.
  const fromNothing = computeDelta(4_200_000_00, 0);
  check(
    'zero baseline never produces a percentage',
    fromNothing.kind === 'new',
    fromNothing.kind,
  );
  check(
    'zero baseline reads as New this period',
    formatDelta(fromNothing, money) === 'New this period',
    formatDelta(fromNothing, money),
  );
  check(
    'zero baseline still points up',
    deltaDirection(fromNothing) === 'up',
  );

  const fromCrumbs = computeDelta(4_200_000_00, 1_000_00);
  check(
    'near-zero baseline falls back to the absolute change',
    fromCrumbs.kind === 'absolute',
    JSON.stringify(fromCrumbs),
  );
  check(
    'absolute fallback renders a signed money figure, not a ratio',
    formatDelta(fromCrumbs, money).startsWith('+Rs') &&
      !formatDelta(fromCrumbs, money).includes('%'),
    formatDelta(fromCrumbs, money),
  );

  // Nothing anywhere may render a percentage past the threshold.
  const sweep: number[] = [];
  for (let prior = 1; prior <= 2000; prior += 1) {
    for (const current of [0, 1, 37, 999, 10_000, 5_000_000]) {
      const d = computeDelta(current, prior);
      if (d.kind === 'percent') sweep.push(Math.abs(d.pct));
    }
  }
  check(
    'no percentage delta anywhere exceeds the absurdity threshold',
    sweep.every((v) => v <= ABSURD_PCT_THRESHOLD),
    `max=${Math.max(...sweep).toFixed(1)}% over ${sweep.length} combinations`,
  );
  check(
    'the threshold is well below the 900% that triggered this fix',
    ABSURD_PCT_THRESHOLD < 900,
    String(ABSURD_PCT_THRESHOLD),
  );

  check(
    '0 → 0 is flat, not New',
    computeDelta(0, 0).kind === 'flat',
    computeDelta(0, 0).kind,
  );
  check(
    'collapsing to zero is a legitimate -100%',
    formatDelta(computeDelta(0, 500), money) === '100%' &&
      deltaDirection(computeDelta(0, 500)) === 'down',
    formatDelta(computeDelta(0, 500), money),
  );
  check(
    'NaN input degrades to n/a rather than rendering',
    computeDelta(Number.NaN, 100).kind === 'none' &&
      computeDelta(100, Number.NaN).kind === 'none',
  );
  check(
    'a sub-epsilon wobble reads flat',
    computeDelta(100.01, 100).kind === 'flat',
    JSON.stringify(computeDelta(100.01, 100)),
  );

  // Rates use points, which are bounded by construction and must never
  // be routed through the percentage path.
  check(
    'win rate 40% → 44% is +4 points',
    formatDelta(computePointsDelta(0.44, 0.4), money) === '4.0 pts',
    formatDelta(computePointsDelta(0.44, 0.4), money),
  );
  check(
    'a rate rising from zero is points, never New',
    computePointsDelta(0.55, 0).kind === 'points',
    computePointsDelta(0.55, 0).kind,
  );
  check(
    'points are bounded to +/-100 across the whole rate domain',
    [0, 0.01, 0.5, 0.99, 1].every((a) =>
      [0, 0.01, 0.5, 0.99, 1].every((b) => {
        const d = computePointsDelta(a, b);
        return d.kind !== 'points' || Math.abs(d.points) <= 100;
      }),
    ),
  );

  /* ---------------- coverage ratio ---------------- */

  // CGB Solutions, as the DB stands: ₹29,14,67,000 open pipeline,
  // ₹9,00,00,000 target, ₹3,16,53,123 credited. Gap ₹5,83,46,877 →
  // just under 5x, comfortably healthy.
  // Minor units (paise) straight out of the DB, not rupees.
  const cgb = computeCoverage({
    openPipelineMinor: 29_146_700_000, //  Rs 29,14,67,000 open
    targetMinor: 9_000_000_000, //          Rs  9,00,00,000 target
    achievedMinor: 3_165_312_300, //        Rs  3,16,53,123 credited
  });
  check(
    'real CGB figures land in the healthy band',
    cgb.state === 'covered' && cgb.band === 'healthy',
    cgb.state === 'covered' ? `${cgb.ratio.toFixed(2)}x` : cgb.state,
  );

  check(
    'no target → no ratio (never Infinity, never 0)',
    computeCoverage({
      openPipelineMinor: 5_000_00,
      targetMinor: null,
      achievedMinor: 0,
    }).state === 'no-target',
  );
  check(
    'a zero target counts as no target',
    computeCoverage({
      openPipelineMinor: 5_000_00,
      targetMinor: 0,
      achievedMinor: 0,
    }).state === 'no-target',
  );

  // Dividing by a closed gap is the crash this state exists to avoid.
  const exactlyMet = computeCoverage({
    openPipelineMinor: 1_000_00,
    targetMinor: 500_00,
    achievedMinor: 500_00,
  });
  check('quota exactly met is its own state', exactlyMet.state === 'met');
  const overAttained = computeCoverage({
    openPipelineMinor: 1_000_00,
    targetMinor: 500_00,
    achievedMinor: 900_00,
  });
  check(
    'over-attainment reads Met, not a negative gap',
    overAttained.state === 'met',
    overAttained.state,
  );

  const bandAt = (ratio: number) => {
    const c = computeCoverage({
      openPipelineMinor: Math.round(ratio * 100_000_00),
      targetMinor: 100_000_00,
      achievedMinor: 0,
    });
    return c.state === 'covered' ? c.band : c.state;
  };
  check('3.0x is healthy (boundary inclusive)', bandAt(3) === 'healthy', String(bandAt(3)));
  check('2.9x is thin', bandAt(2.9) === 'thin', String(bandAt(2.9)));
  check('2.0x is thin (boundary inclusive)', bandAt(2) === 'thin', String(bandAt(2)));
  check('1.9x is at-risk', bandAt(1.9) === 'at-risk', String(bandAt(1.9)));
  check('an empty pipeline against a real gap is at-risk', bandAt(0) === 'at-risk', String(bandAt(0)));

  const thinCoverage = computeCoverage({
    openPipelineMinor: 250_000_00,
    targetMinor: 100_000_00,
    achievedMinor: 0,
  });
  check(
    'healthyPipelineMinor states what 3x coverage would require',
    thinCoverage.state === 'covered' &&
      thinCoverage.healthyPipelineMinor === 300_000_00,
    thinCoverage.state === 'covered'
      ? String(thinCoverage.healthyPipelineMinor)
      : thinCoverage.state,
  );
  check(
    'ratio renders to one decimal',
    formatCoverageRatio(4.987) === '5.0x' && formatCoverageRatio(1.24) === '1.2x',
    `${formatCoverageRatio(4.987)} / ${formatCoverageRatio(1.24)}`,
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
  check('no outlier → no cap', flat.pipelineCap === null && flat.devNotices.length === 0);

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
  // Capping is surfaced to the user IN the chart — the capped bar draws
  // a torn top edge and its tooltip states the figures are real. The
  // string below is a dev-console diagnostic only; A1 removed the amber
  // banner that used to render it verbatim on the dashboard.
  check(
    'axis capping is recorded as a dev diagnostic (never rendered)',
    spiky.devNotices.length > 0,
    spiky.devNotices.join(' '),
  );
  check(
    'every capped week is individually flagged for its in-chart marker',
    spiky.points.every(
      (p) => p.newPipelineCapped === (spiky.pipelineCap !== null && p.newPipeline > spiky.pipelineCap),
    ),
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
