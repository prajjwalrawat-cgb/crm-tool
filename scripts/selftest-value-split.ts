import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for the TCV breakdown. Covers the pure rules — contract-year
 * generation, leap-year anniversaries, remainder handling, the one-time vs
 * recurring auto-fill, the element/year grid invariants and the sum-to-Amount
 * rule — plus a DB round-trip through the replace-wholesale write under RLS.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

type TenantRow = { id: string };

async function main() {
  const {
    addYearsISO,
    componentDisplayName,
    contractYearPeriods,
    elementsToRows,
    generateElementAmounts,
    rowsToElements,
    spreadEvenly,
    sumSplit,
    validateSplit,
    splitSummary,
    yearTotals,
    isMonthlyProrated,
    proratedFiscalYearSplit,
  } = await import('../src/lib/deals/value-split');
  type SplitElement = import('../src/lib/deals/value-split').SplitElement;

  /* ---------- Support / AMC financial-year proration ---------- */

  check(
    'support and AMC are prorated monthly; licence is not',
    isMonthlyProrated('support') && isMonthlyProrated('amc') && !isMonthlyProrated('license'),
  );
  const amcFy = proratedFiscalYearSplit([108_000_000], '2026-11-01', 4);
  check(
    'a Nov start with an April FY puts 5 months in the current FY, 7 in the next',
    amcFy.length === 2 &&
      amcFy[0]!.fiscalYear === 2026 && amcFy[0]!.months === 5 && amcFy[0]!.amountMinor === 45_000_000 &&
      amcFy[1]!.fiscalYear === 2027 && amcFy[1]!.months === 7 && amcFy[1]!.amountMinor === 63_000_000,
    JSON.stringify(amcFy),
  );
  const aprFy = proratedFiscalYearSplit([1_200_000], '2026-04-01', 4);
  check(
    'a contract year starting on the FY start stays in one FY',
    aprFy.length === 1 && aprFy[0]!.months === 12 && aprFy[0]!.amountMinor === 1_200_000,
  );
  const multiFy = proratedFiscalYearSplit([1_000_001, 2_000_000, 0], '2026-11-15', 4);
  check(
    'multi-year proration covers every FY touched and sums exactly',
    multiFy.map((s) => s.fiscalYear).join(',') === '2026,2027,2028,2029' &&
      multiFy.reduce((a, s) => a + s.amountMinor, 0) === 3_000_001 &&
      multiFy.reduce((a, s) => a + s.months, 0) === 36,
    JSON.stringify(multiFy),
  );

  /* ---------- contract years ---------- */

  const periods = contractYearPeriods('2026-08-01', 3);
  check('generates one period per contract year', periods.length === 3);
  check(
    'year 1 starts on the contract start',
    periods[0]!.periodStart === '2026-08-01',
  );
  check(
    'later years start on the anniversary',
    periods[1]!.periodStart === '2027-08-01' &&
      periods[2]!.periodStart === '2028-08-01',
  );
  check(
    "a year's end is the next year's start",
    periods[0]!.periodEnd === periods[1]!.periodStart,
  );
  check(
    'a 29-Feb start clamps to 28-Feb in common years',
    addYearsISO('2028-02-29', 1) === '2029-02-28',
  );
  check(
    'a 29-Feb start stays 29-Feb across a leap gap',
    addYearsISO('2028-02-29', 4) === '2032-02-29',
  );
  check(
    'term below 1 is rejected',
    (() => {
      try {
        contractYearPeriods('2026-08-01', 0);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  /* ---------- even spread and remainders ---------- */

  const spread = spreadEvenly(1_000_000, 3);
  check(
    'an even spread sums to the total exactly',
    spread.reduce((a, b) => a + b, 0) === 1_000_000,
  );
  check(
    'the remainder lands on the first slot',
    spread[0]! === 333_334 && spread[1]! === 333_333 && spread[2]! === 333_333,
    spread.join('/'),
  );

  /* ---------- billing type auto-fill ---------- */

  const oneTime = generateElementAmounts('one_time', 3, 500_000);
  check(
    'a one-time element puts everything in year 1',
    oneTime[0]! === 500_000 && oneTime[1]! === 0 && oneTime[2]! === 0,
    oneTime.join('/'),
  );
  const recurring = generateElementAmounts('recurring', 3, 900_000);
  check(
    'a recurring element spreads across the term',
    recurring.every((v) => v === 300_000),
    recurring.join('/'),
  );
  check(
    'auto-fill never loses money to rounding',
    generateElementAmounts('recurring', 7, 1_000_000).reduce((a, b) => a + b, 0) ===
      1_000_000,
  );

  /* ---------- the grid ---------- */

  // A realistic mix: one-off licence + implementation, recurring AMC.
  const elements: SplitElement[] = [
    {
      elementIndex: 1,
      component: 'license',
      componentLabel: null,
      billingType: 'one_time',
      amountsMinor: generateElementAmounts('one_time', 3, 1_000_000),
    },
    {
      elementIndex: 2,
      component: 'implementation',
      componentLabel: null,
      billingType: 'one_time',
      amountsMinor: generateElementAmounts('one_time', 3, 300_000),
    },
    {
      elementIndex: 3,
      component: 'amc',
      componentLabel: null,
      billingType: 'recurring',
      amountsMinor: generateElementAmounts('recurring', 3, 600_000),
    },
  ];
  const TOTAL = 1_900_000;

  const rows = elementsToRows(elements, '2026-08-01', 3);
  check(
    'the grid has one cell per element per year',
    rows.length === 9,
    String(rows.length),
  );
  check(
    'the grid sums to the deal amount',
    sumSplit(rows) === TOTAL,
    String(sumSplit(rows)),
  );
  check('a balanced grid validates', validateSplit(rows, TOTAL).ok);

  const totals = yearTotals(elements, 3);
  check(
    'year 1 carries both one-off fees plus the first AMC',
    totals[0]! === 1_000_000 + 300_000 + 200_000,
    String(totals[0]),
  );
  check(
    'later years carry only the recurring element',
    totals[1]! === 200_000 && totals[2]! === 200_000,
    totals.join('/'),
  );

  // elementsToRows / rowsToElements are inverses.
  const roundTripped = rowsToElements(rows);
  check(
    'rows convert back to the same elements',
    JSON.stringify(roundTripped) === JSON.stringify(elements),
  );

  /* ---------- validation rules ---------- */

  const short = validateSplit(rows, TOTAL + 100_000);
  check('a short grid is rejected', !short.ok);
  check(
    'the shortfall is reported as a signed difference',
    !short.ok && short.differenceMinor === 100_000,
    !short.ok ? String(short.differenceMinor) : undefined,
  );
  check('an over-allocated grid is rejected', !validateSplit(rows, TOTAL - 1).ok);
  check('an empty grid is rejected', !validateSplit([], 1000).ok);

  // A gap in element numbering would make the grid ambiguous.
  const gapped = rows.filter((r) => r.elementIndex !== 2);
  check(
    'a gap in the element numbering is rejected',
    !validateSplit(gapped, sumSplit(gapped)).ok,
  );

  // Every element needs a cell for every year, or per-year totals under-report.
  const incomplete = rows.filter(
    (r) => !(r.elementIndex === 3 && r.yearIndex === 3),
  );
  check(
    'a missing cell is rejected',
    !validateSplit(incomplete, sumSplit(incomplete)).ok,
  );

  // An element must describe itself the same way in every year.
  const inconsistent = rows.map((r) =>
    r.elementIndex === 3 && r.yearIndex === 2
      ? { ...r, component: 'support' as const }
      : r,
  );
  check(
    'an element that changes identity mid-term is rejected',
    !validateSplit(inconsistent, TOTAL).ok,
  );

  // `other` is the escape hatch, but it has to be named.
  const unnamedOther = elementsToRows(
    [
      {
        elementIndex: 1,
        component: 'other',
        componentLabel: '   ',
        billingType: 'one_time',
        amountsMinor: [TOTAL],
      },
    ],
    '2026-08-01',
    1,
  );
  check(
    'an unnamed custom element is rejected',
    !validateSplit(unnamedOther, TOTAL).ok,
  );

  const namedOther = elementsToRows(
    [
      {
        elementIndex: 1,
        component: 'other',
        componentLabel: 'Data migration',
        billingType: 'one_time',
        amountsMinor: [TOTAL],
      },
    ],
    '2026-08-01',
    1,
  );
  check('a named custom element is accepted', validateSplit(namedOther, TOTAL).ok);
  check(
    'a custom element displays its own label',
    componentDisplayName('other', 'Data migration') === 'Data migration',
  );
  check(
    'a standard element displays its canonical name',
    componentDisplayName('amc', null) === 'AMC',
  );

  // billingType is intent, not a constraint: a one-time fee invoiced over two
  // years is a legitimate contract and must not be rejected.
  const instalments = elementsToRows(
    [
      {
        elementIndex: 1,
        component: 'implementation',
        componentLabel: null,
        billingType: 'one_time',
        amountsMinor: [600_000, 400_000],
      },
    ],
    '2026-08-01',
    2,
  );
  check(
    'a one-time element paid in instalments is allowed',
    validateSplit(instalments, 1_000_000).ok,
  );

  const summary = splitSummary(rows);
  check(
    'summary reads back the start, term and element count',
    summary?.startISO === '2026-08-01' &&
      summary?.termYears === 3 &&
      summary?.elementCount === 3,
    JSON.stringify(summary),
  );

  /* ---------- DB round-trip ---------- */

  const { db, client } = await import('../src/db/index');
  const { deals, dealValueSplits } = await import('../src/db/schema');
  const { replaceDealValueSplit, listDealValueSplitsFor } = await import(
    '../src/lib/deals/value-split-queries'
  );

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(
        sql`select set_config('app.user_id', 'selftest-value-split', true)`,
      );
      return fn(tx);
    });
  }

  const tenantRows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (tenantRows.length === 0) {
    console.error('No tenants.');
    process.exit(2);
  }
  const tenantId = tenantRows[0]!.id;
  console.log(`tenant=${tenantId}`);

  let dealId = '';
  try {
    dealId = await txAs(tenantId, async (tx) => {
      const [row] = await tx
        .insert(deals)
        .values({
          tenantId,
          name: 'value-split selftest',
          stage: 'qualified',
          amountMinor: TOTAL,
          currency: 'INR',
          ownerId: 'value-split-selftest-owner',
        })
        .returning({ id: deals.id });
      return row!.id;
    });

    await txAs(tenantId, (tx) =>
      replaceDealValueSplit(tx, { tenantId, dealId, rows }),
    );
    const stored = await txAs(tenantId, (tx) =>
      listDealValueSplitsFor(tx, tenantId, [dealId]),
    );
    const back = stored.get(dealId) ?? [];
    check('round-trips every cell of the grid', back.length === 9, String(back.length));
    check(
      'round-trips the element identity',
      back.every(
        (r) =>
          r.component ===
          rows.find(
            (o) => o.elementIndex === r.elementIndex && o.yearIndex === r.yearIndex,
          )?.component,
      ),
    );
    check(
      'round-trips billing type',
      back.find((r) => r.elementIndex === 1)?.billingType === 'one_time' &&
        back.find((r) => r.elementIndex === 3)?.billingType === 'recurring',
    );
    check(
      'round-trips the amounts and dates',
      sumSplit(back) === TOTAL &&
        back[0]!.periodStart === '2026-08-01' &&
        back.find((r) => r.yearIndex === 3)?.periodEnd === '2029-08-01',
      `${sumSplit(back)} ${back[0]!.periodStart}`,
    );
    check(
      'the stored grid still validates after a round-trip',
      validateSplit(back, TOTAL).ok,
    );

    // A custom element survives its label, and re-saving replaces wholesale.
    const withCustom = elementsToRows(
      [
        {
          elementIndex: 1,
          component: 'other',
          componentLabel: 'Data migration',
          billingType: 'one_time',
          amountsMinor: [TOTAL],
        },
      ],
      '2026-08-01',
      1,
    );
    await txAs(tenantId, (tx) =>
      replaceDealValueSplit(tx, { tenantId, dealId, rows: withCustom }),
    );
    const customBack = await txAs(tenantId, (tx) =>
      listDealValueSplitsFor(tx, tenantId, [dealId]),
    );
    check(
      'a custom element round-trips its label',
      (customBack.get(dealId) ?? [])[0]?.componentLabel === 'Data migration',
      String((customBack.get(dealId) ?? [])[0]?.componentLabel),
    );
    check(
      're-saving replaces the previous grid',
      (customBack.get(dealId) ?? []).length === 1,
      String((customBack.get(dealId) ?? []).length),
    );

    // Clearing leaves the deal amount untouched — the breakdown is reporting only.
    await txAs(tenantId, (tx) =>
      replaceDealValueSplit(tx, { tenantId, dealId, rows: [] }),
    );
    const cleared = await txAs(tenantId, (tx) =>
      listDealValueSplitsFor(tx, tenantId, [dealId]),
    );
    check('clearing removes every row', (cleared.get(dealId) ?? []).length === 0);

    const amountAfter = await txAs(tenantId, async (tx) => {
      const [d] = await tx
        .select({ amountMinor: deals.amountMinor })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      return d!.amountMinor;
    });
    check(
      'the deal amount is never touched by the breakdown',
      amountAfter === TOTAL,
      String(amountAfter),
    );
  } finally {
    if (dealId) {
      await txAs(tenantId, async (tx) => {
        await tx
          .delete(dealValueSplits)
          .where(
            and(
              eq(dealValueSplits.dealId, dealId),
              eq(dealValueSplits.tenantId, tenantId),
            ),
          );
        await tx
          .delete(deals)
          .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      });
    }
    await client.end();
  }

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
