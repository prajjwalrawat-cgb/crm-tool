import { config } from 'dotenv';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Self-test for Module 4 — Forecast Rollup. Covers the pure category
 * derivation + period math, then a DB-backed reconciliation: the rollup's
 * grand total (categories + overdue) must equal a board-style Σ amount_minor
 * over the SAME filters, and open past-dated deals must land in `overdue` and
 * be EXCLUDED from Commit. Uses a fully-past period (2020-Q1) so every open
 * deal in it is deterministically overdue, and far-off dates so it never
 * collides with real deals. Cleans up after itself.
 */
type TenantRow = { id: string };
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { deriveForecastCategory } = await import('../src/lib/deals/forecast/categories');
  const { resolvePeriod } = await import('../src/lib/deals/forecast/period');
  const { DEFAULT_STAGE_PROBABILITY } = await import('../src/lib/deals/stage-probability');

  /* -------- pure: category derivation -------- */
  check('derive qualified→pipeline', deriveForecastCategory('qualified') === 'pipeline');
  check('derive proposal→best_case', deriveForecastCategory('proposal') === 'best_case');
  check('derive negotiation→commit', deriveForecastCategory('negotiation') === 'commit');
  check('derive won→closed_won', deriveForecastCategory('won') === 'closed_won');
  check('derive lost→omitted', deriveForecastCategory('lost') === 'omitted');
  check('derive hold→omitted', deriveForecastCategory('hold') === 'omitted');

  /* -------- pure: period math (Jan fiscal year) -------- */
  const q = resolvePeriod('quarter', null, new Date('2026-08-15T00:00:00Z'), 1);
  check('quarter contains Aug → Q3 Jul–Oct', q.startISO === '2026-07-01' && q.endISO === '2026-10-01', `${q.startISO}..${q.endISO}`);
  const m = resolvePeriod('month', null, new Date('2026-08-15T00:00:00Z'), 1);
  check('month Aug range', m.startISO === '2026-08-01' && m.endISO === '2026-09-01', `${m.startISO}..${m.endISO}`);

  /* -------- DB: reconciliation + overdue -------- */
  const { db, client } = await import('../src/db/index');
  const { deals } = await import('../src/db/schema');
  const { getForecastRollup } = await import('../src/lib/deals/forecast/rollup');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'selftest-fc', true)`);
      return fn(tx);
    });
  }

  const rows = (await db.execute(sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`)) as unknown as TenantRow[];
  if (rows.length === 0) { console.error('No tenants.'); process.exit(2); }
  const tenantId = rows[0]!.id;
  const START = '2020-01-01';
  const END = '2020-04-01';
  const O1 = 'fc-owner-1';
  const O2 = 'fc-owner-2';
  const ids: string[] = [];

  try {
    ids.push(...(await txAs(tenantId, async (tx) => {
      const inserted = await tx.insert(deals).values([
        { tenantId, name: 'FC A qualified', stage: 'qualified', amountMinor: 1000, currency: 'INR', expectedCloseDate: '2020-01-15', ownerId: O1, forecastCategory: 'pipeline' },
        { tenantId, name: 'FC B proposal', stage: 'proposal', amountMinor: 2000, currency: 'INR', expectedCloseDate: '2020-02-10', ownerId: O1, forecastCategory: 'best_case' },
        { tenantId, name: 'FC C negotiation', stage: 'negotiation', amountMinor: 4000, currency: 'INR', expectedCloseDate: '2020-03-01', ownerId: O2, forecastCategory: 'commit' },
        { tenantId, name: 'FC D won', stage: 'won', amountMinor: 8000, currency: 'INR', expectedCloseDate: '2020-01-20', ownerId: O2, forecastCategory: 'closed_won' },
      ]).returning({ id: deals.id });
      return inserted.map((r) => r.id);
    })));

    await txAs(tenantId, async (tx) => {
      const rollup = await getForecastRollup(
        { tenantId, startISO: START, endISO: END, probabilities: DEFAULT_STAGE_PROBABILITY },
        tx,
      );

      // Board-style Σ amount over the SAME filters.
      const [board] = await tx
        .select({ amt: sql<string>`coalesce(sum(${deals.amountMinor}),0)::bigint`, n: sql<number>`count(*)::int` })
        .from(deals)
        .where(and(
          eq(deals.tenantId, tenantId),
          isNull(deals.deletedAt),
          gte(deals.expectedCloseDate, START),
          lt(deals.expectedCloseDate, END),
        ));
      const boardTotal = Number(board?.amt ?? 0);

      check('grand total reconciles with board Σ', rollup.grandTotal.amountMinor === boardTotal && boardTotal === 15000, `rollup=${rollup.grandTotal.amountMinor} board=${boardTotal}`);
      check('overdue = 3 open past-dated deals (7000)', rollup.overdue.amountMinor === 7000 && rollup.overdue.count === 3, `amt=${rollup.overdue.amountMinor} n=${rollup.overdue.count}`);
      // Won deal is NOT overdue → stays in closed_won; negotiation(commit) is overdue → excluded.
      check('commit excludes overdue (only closed_won 8000)', rollup.commit.rawMinor === 8000, `commit=${rollup.commit.rawMinor}`);
      check('best case excludes overdue proposal/negotiation', rollup.bestCase.rawMinor === 8000, `bestCase=${rollup.bestCase.rawMinor}`);
      check('closed_won category total = 8000', rollup.categoryTotals.closed_won.amountMinor === 8000);
      check('team total (non-overdue) = 8000', rollup.teamTotal.amountMinor === 8000);
      check('commit weighted = 8000 (won prob 100)', rollup.commit.weightedMinor === 8000, `w=${rollup.commit.weightedMinor}`);
    });
  } finally {
    await txAs(tenantId, async (tx) => {
      for (const id of ids) {
        await tx.delete(deals).where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)));
      }
    });
  }

  console.log('\n─── Forecast rollup self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => { console.error('selftest fatal:', err); process.exit(1); });
