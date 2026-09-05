import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for fiscal-year attribution on Sales Targets.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. THE PURE RULE. Overlap arithmetic on hand-built windows —
 *      anniversary contract years straddling a fiscal boundary, leap
 *      years, non-overlap in both directions, and the partition property
 *      (a contract year handed to consecutive fiscal years is counted
 *      once in total, never twice).
 *
 *   2. THE SQL AGREES WITH IT. `targetAchievement` computes attribution
 *      in Postgres; `attributeToFiscalYear` computes it in JS. Two
 *      implementations of one rule is exactly the setup that let the
 *      quota credit rule drift for months (see `lib/targets/quota-credit`).
 *      So this runs the real query over the real tenant, recomputes the
 *      same answer in JS from the raw split rows, and asserts they match
 *      to the rupee.
 *
 *   3. THE INVARIANTS. fyRevenue + future + prior === tcvWon, and
 *      fyRevenue <= tcvWon — the two properties the card's layout claims
 *      are true when it puts those figures next to each other.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

/** Money comparisons tolerate sub-unit rounding drift, nothing more. */
function near(a: number, b: number, tolerance = 2): boolean {
  return Math.abs(a - b) <= tolerance;
}

type TenantRow = { id: string; name: string };
type SplitRow = {
  deal_id: string;
  period_start: string;
  period_end: string;
  amount_minor: string | number;
};
type DealRow = {
  id: string;
  owner_id: string | null;
  amount_minor: string | number;
  quota_weight: string | number;
};

async function main() {
  const {
    attributeToFiscalYear,
    marginCoverageNote,
    overlapDays,
    overlapFraction,
    splitCoverageNote,
    toISODate,
  } = await import('../src/lib/targets/fy-attribution');
  const { fiscalYearRange } = await import('../src/lib/targets/fiscal');

  /* ---------- 1: the pure rule ---------- */

  // A contract year starting 01-07-2026 runs to 30-06-2027. Calendar 2026
  // gets 01-07 → 31-12: 184 days of 365.
  check(
    'contract year straddling a fiscal boundary splits by days',
    overlapDays('2026-07-01', '2027-07-01', '2026-01-01', '2027-01-01') === 184,
    `got ${overlapDays('2026-07-01', '2027-07-01', '2026-01-01', '2027-01-01')}`,
  );

  // The partition property: the same contract year handed to two adjacent
  // fiscal years must total the whole year, not more and not less. This is
  // what half-open windows buy, and the reason the fix can't double-count.
  const y1 = overlapDays('2026-07-01', '2027-07-01', '2026-01-01', '2027-01-01');
  const y2 = overlapDays('2026-07-01', '2027-07-01', '2027-01-01', '2028-01-01');
  check(
    'adjacent fiscal years partition a contract year exactly',
    y1 + y2 === 365,
    `${y1} + ${y2} = ${y1 + y2}, expected 365`,
  );

  check(
    'fraction of a straddling year is days-based, not months-based',
    Math.abs(
      overlapFraction('2026-07-01', '2027-07-01', '2026-01-01', '2027-01-01') -
        184 / 365,
    ) < 1e-9,
  );

  check(
    'a contract entirely after the window contributes nothing',
    overlapFraction('2027-02-01', '2028-02-01', '2026-01-01', '2027-01-01') === 0,
  );
  check(
    'a contract entirely before the window contributes nothing',
    overlapFraction('2024-01-01', '2025-01-01', '2026-01-01', '2027-01-01') === 0,
  );
  check(
    'a contract year inside the window contributes all of itself',
    overlapFraction('2026-02-01', '2026-11-01', '2026-01-01', '2027-01-01') === 1,
  );

  // A leap contract year is 366 days; the divisor has to follow the actual
  // dates rather than assume 365, or every 4th year drifts.
  check(
    'leap contract year uses its own length as the divisor',
    overlapFraction('2028-01-01', '2029-01-01', '2028-01-01', '2029-01-01') === 1 &&
      overlapDays('2028-01-01', '2029-01-01', '2028-01-01', '2029-01-01') === 366,
  );

  // The real case from CGB: ₹70,47,009 over 2 years from 01-07-2026.
  const vadodra = attributeToFiscalYear(
    [
      { periodStart: '2026-07-01', periodEnd: '2027-07-01', amountMinor: 352_350_450 },
      { periodStart: '2027-07-01', periodEnd: '2028-07-01', amountMinor: 352_350_450 },
    ],
    '2026-01-01',
    '2027-01-01',
    704_700_900,
  );
  check(
    'two-year contract puts only its 2026 days in FY2026',
    near(vadodra.inFyMinor, 352_350_450 * (184 / 365), 1),
    `got ${vadodra.inFyMinor}`,
  );
  check(
    'the rest of that contract is reported as future, not dropped',
    near(vadodra.inFyMinor + vadodra.priorMinor + vadodra.futureMinor, 704_700_900, 1),
    `buckets sum to ${vadodra.inFyMinor + vadodra.priorMinor + vadodra.futureMinor}`,
  );

  // A deal whose contract began before the window opened: the early part is
  // prior-period, not future-period. Mislabelling it would be the same class
  // of error as the bug being fixed.
  const backdated = attributeToFiscalYear(
    [{ periodStart: '2025-07-01', periodEnd: '2026-07-01', amountMinor: 100_000_000 }],
    '2026-01-01',
    '2027-01-01',
    100_000_000,
  );
  check(
    'a contract starting before the window reports a prior-period share',
    backdated.priorMinor > 0 && near(backdated.futureMinor, 0, 1),
    `prior=${backdated.priorMinor} future=${backdated.futureMinor}`,
  );

  // No breakdown = single-year assumption. The whole TCV, nothing future.
  const noSplit = attributeToFiscalYear([], '2026-01-01', '2027-01-01', 5_000_000);
  check(
    'a deal with no breakdown counts in full against the year',
    noSplit.inFyMinor === 5_000_000 && noSplit.futureMinor === 0,
  );

  /* ---------- disclosures ---------- */

  check(
    'coverage note stays silent when every deal has a breakdown',
    splitCoverageNote(0, 21) === null,
  );
  check(
    'coverage note names both counts when it fires',
    (splitCoverageNote(18, 21) ?? '').includes('18 of 21'),
    splitCoverageNote(18, 21) ?? 'null',
  );
  check(
    'margin note stays silent when every deal has a margin',
    marginCoverageNote(0, 22) === null,
  );
  check(
    'margin note distinguishes missing data from zero margin',
    (marginCoverageNote(20, 22) ?? '').includes('not as missing'),
    marginCoverageNote(20, 22) ?? 'null',
  );

  /* ---------- 2 + 3: the SQL agrees, over real data ---------- */

  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { targetAchievement } = await import('../src/lib/targets/queries');

  const tenants = (await db.execute(
    sql`SELECT id, name FROM tenants ORDER BY name`,
  )) as unknown as TenantRow[];

  const now = new Date();
  const fiscalYear = now.getUTCFullYear();
  const startMonth = 1;
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  const fyStartISO = toISODate(start);
  const fyEndISO = toISODate(end);

  let comparedTenants = 0;
  let comparedOwners = 0;

  for (const t of tenants) {
    const rows = await runWithSystemContext(t.id, async () =>
      targetAchievement(t.id, fiscalYear, startMonth),
    );
    if (rows.length === 0) continue;
    comparedTenants++;

    // Recompute the same answer in JS, from the raw rows the query read.
    const deals = (await db.execute(sql`
      SELECT id, owner_id, amount_minor, quota_weight
      FROM deals
      WHERE tenant_id = ${t.id}::uuid
        AND stage = 'won'
        AND owner_id IS NOT NULL
        AND deleted_at IS NULL
        AND approval_status IN ('none', 'approved')
        AND closed_at >= ${start.toISOString()}::timestamptz
        AND closed_at <  ${end.toISOString()}::timestamptz
    `)) as unknown as DealRow[];

    const splits = (await db.execute(sql`
      SELECT s.deal_id, s.period_start::text, s.period_end::text, s.amount_minor
      FROM deal_value_splits s
      WHERE s.tenant_id = ${t.id}::uuid
    `)) as unknown as SplitRow[];

    const splitsByDeal = new Map<string, SplitRow[]>();
    for (const s of splits) {
      const list = splitsByDeal.get(s.deal_id) ?? [];
      list.push(s);
      splitsByDeal.set(s.deal_id, list);
    }

    const expected = new Map<string, { fy: number; tcv: number }>();
    for (const d of deals) {
      const amount = Number(d.amount_minor);
      const weight = Number(d.quota_weight);
      const attribution = attributeToFiscalYear(
        (splitsByDeal.get(d.id) ?? []).map((s) => ({
          periodStart: s.period_start,
          periodEnd: s.period_end,
          amountMinor: Number(s.amount_minor),
        })),
        fyStartISO,
        fyEndISO,
        amount,
      );
      const acc = expected.get(d.owner_id!) ?? { fy: 0, tcv: 0 };
      acc.fy += Math.round(attribution.inFyMinor * weight);
      acc.tcv += Math.round(amount * weight);
      expected.set(d.owner_id!, acc);
    }

    for (const r of rows) {
      comparedOwners++;
      const exp = expected.get(r.userId) ?? { fy: 0, tcv: 0 };

      check(
        `[${t.name}/${r.userId.slice(0, 12)}] SQL attribution matches the JS rule`,
        near(r.fyRevenueMinor, exp.fy, rows.length + 2),
        `sql=${r.fyRevenueMinor} js=${exp.fy}`,
      );
      check(
        `[${t.name}/${r.userId.slice(0, 12)}] TCV won is unchanged by attribution`,
        near(r.tcvWonMinor, exp.tcv, 2),
        `sql=${r.tcvWonMinor} js=${exp.tcv}`,
      );
      // The card puts these three next to each other and implies they add up.
      check(
        `[${t.name}/${r.userId.slice(0, 12)}] fy + future + prior === TCV won`,
        r.fyRevenueMinor + r.futurePeriodMinor + r.priorPeriodMinor === r.tcvWonMinor,
        `${r.fyRevenueMinor} + ${r.futurePeriodMinor} + ${r.priorPeriodMinor} != ${r.tcvWonMinor}`,
      );
      check(
        `[${t.name}/${r.userId.slice(0, 12)}] fiscal-year revenue never exceeds TCV`,
        r.fyRevenueMinor <= r.tcvWonMinor,
        `fy=${r.fyRevenueMinor} tcv=${r.tcvWonMinor}`,
      );
      // The counts the card discloses have to cover the cohort it names.
      check(
        `[${t.name}/${r.userId.slice(0, 12)}] breakdown + margin counts cover the won cohort`,
        r.splitCount + r.splitlessCount === r.wonCount &&
          r.marginKnownCount + r.marginMissingCount === r.wonCount,
        `won=${r.wonCount} split=${r.splitCount}+${r.splitlessCount} margin=${r.marginKnownCount}+${r.marginMissingCount}`,
      );
    }
  }

  check(
    'the SQL/JS comparison actually ran against data',
    comparedOwners > 0,
    `${comparedTenants} tenants, ${comparedOwners} owners compared`,
  );

  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed ` +
      `(${comparedTenants} tenants, ${comparedOwners} owners compared)`,
  );

  await client.end?.();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
