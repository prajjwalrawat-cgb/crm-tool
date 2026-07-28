import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for the multi-year TCV split. Covers the pure contract-year rules
 * (generation, leap-year anniversaries, remainder handling, the sum-to-Amount
 * rule) and a DB round-trip through the replace-wholesale write under RLS.
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
    generateContractYears,
    sumSplit,
    validateSplit,
    splitSummary,
  } = await import('../src/lib/deals/value-split');

  /* ---------- pure rules ---------- */

  const years = generateContractYears('2026-08-01', 3, 3_000_000);
  check('generates one row per contract year', years.length === 3);
  check(
    'year 1 starts on the contract start',
    years[0]!.periodStart === '2026-08-01',
    years[0]!.periodStart,
  );
  check(
    'later years start on the anniversary',
    years[1]!.periodStart === '2027-08-01' && years[2]!.periodStart === '2028-08-01',
    `${years[1]!.periodStart}, ${years[2]!.periodStart}`,
  );
  check(
    'each year ends where the next begins',
    years[0]!.periodEnd === years[1]!.periodStart &&
      years[1]!.periodEnd === years[2]!.periodStart,
  );
  check(
    'even split sums to the total',
    sumSplit(years) === 3_000_000,
    String(sumSplit(years)),
  );

  // Minor units are integers: 10,000 over 3 years cannot be three equal rows.
  const uneven = generateContractYears('2026-01-01', 3, 10_000);
  check(
    'indivisible total still sums exactly',
    sumSplit(uneven) === 10_000,
    `${uneven.map((r) => r.amountMinor).join('+')}=${sumSplit(uneven)}`,
  );
  check(
    'remainder lands on year 1',
    uneven[0]!.amountMinor === 3334 && uneven[1]!.amountMinor === 3333,
    uneven.map((r) => r.amountMinor).join(','),
  );

  // 29 Feb has no anniversary in a common year.
  check(
    'leap-day start clamps to 28 Feb',
    addYearsISO('2028-02-29', 1) === '2029-02-28',
    addYearsISO('2028-02-29', 1),
  );
  check(
    'leap-day start keeps 29 Feb four years on',
    addYearsISO('2028-02-29', 4) === '2032-02-29',
    addYearsISO('2028-02-29', 4),
  );

  /* ---------- the sum-to-Amount rule ---------- */

  check('a balanced split validates', validateSplit(years, 3_000_000).ok);

  const short = validateSplit(years, 3_500_000);
  check('a short split is rejected', !short.ok);
  check(
    'the shortfall is reported',
    !short.ok && short.differenceMinor === 500_000,
    String(!short.ok ? short.differenceMinor : ''),
  );

  const over = validateSplit(years, 2_500_000);
  check(
    'an over-allocated split reports a negative difference',
    !over.ok && over.differenceMinor === -500_000,
    String(!over.ok ? over.differenceMinor : ''),
  );

  check('an empty split is rejected', !validateSplit([], 1000).ok);
  check(
    'gapped year numbering is rejected',
    !validateSplit(
      [
        { yearIndex: 1, periodStart: '2026-01-01', periodEnd: '2027-01-01', amountMinor: 500 },
        { yearIndex: 3, periodStart: '2027-01-01', periodEnd: '2028-01-01', amountMinor: 500 },
      ],
      1000,
    ).ok,
  );
  check(
    'a backwards period is rejected',
    !validateSplit(
      [
        { yearIndex: 1, periodStart: '2027-01-01', periodEnd: '2026-01-01', amountMinor: 1000 },
      ],
      1000,
    ).ok,
  );
  check(
    'summary reads back the start and term',
    splitSummary(years)?.startISO === '2026-08-01' &&
      splitSummary(years)?.termYears === 3,
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
          amountMinor: 3_000_000,
          currency: 'INR',
          ownerId: 'value-split-selftest-owner',
        })
        .returning({ id: deals.id });
      return row!.id;
    });

    await txAs(tenantId, (tx) =>
      replaceDealValueSplit(tx, { tenantId, dealId, rows: years }),
    );
    const stored = await txAs(tenantId, (tx) =>
      listDealValueSplitsFor(tx, tenantId, [dealId]),
    );
    const back = stored.get(dealId) ?? [];
    check('round-trips every year', back.length === 3, String(back.length));
    check(
      'round-trips the amounts and dates',
      back[0]!.amountMinor === years[0]!.amountMinor &&
        back[0]!.periodStart === '2026-08-01' &&
        back[2]!.periodEnd === '2029-08-01',
      `${back[0]!.amountMinor} ${back[0]!.periodStart} ${back[2]!.periodEnd}`,
    );

    // Saving again replaces rather than accumulates.
    const shorter = generateContractYears('2026-08-01', 2, 3_000_000);
    await txAs(tenantId, (tx) =>
      replaceDealValueSplit(tx, { tenantId, dealId, rows: shorter }),
    );
    const afterReplace = await txAs(tenantId, (tx) =>
      listDealValueSplitsFor(tx, tenantId, [dealId]),
    );
    check(
      're-saving replaces the previous years',
      (afterReplace.get(dealId) ?? []).length === 2,
      String((afterReplace.get(dealId) ?? []).length),
    );

    // Clearing leaves the deal amount untouched — the split is reporting only.
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
      'the deal amount is never touched by the split',
      amountAfter === 3_000_000,
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
