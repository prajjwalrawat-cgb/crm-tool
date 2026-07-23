import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for Module 6 (Hold Stage Cleanup). Verifies: held deals
 * freeze scoring (recompute → null), the revisit-due cron creates an owner task
 * (idempotently), and a held deal is omitted from the forecast Commit/Best-case.
 */
type TenantRow = { id: string };
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { workspaceSettings, deals, tasks, activityLogs } = await import('../src/db/schema');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { recomputeDealScore } = await import('../src/lib/deals/scoring/service');
  const { runHoldRevisitScan } = await import('../src/lib/inngest/workflows/hold-revisit-daily');
  const { getForecastRollup } = await import('../src/lib/deals/forecast/rollup');
  const { DEFAULT_STAGE_PROBABILITY } = await import('../src/lib/deals/stage-probability');
  const { deriveForecastCategory } = await import('../src/lib/deals/forecast/categories');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'selftest-hold', true)`);
      return fn(tx);
    });
  }

  const rows = (await db.execute(sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`)) as unknown as TenantRow[];
  if (rows.length === 0) { console.error('No tenants.'); process.exit(2); }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  // Pure: hold derives to omitted.
  check('hold derives to omitted', deriveForecastCategory('hold') === 'omitted');

  const priorScore = await txAs(tenantId, async (tx) => {
    const r = await tx.select({ e: workspaceSettings.dealScoringEnabled }).from(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
    return r[0]?.e ?? null;
  });

  const OWNER = 'hold-owner-selftest';
  let heldId = '', fcHeldId = '';

  try {
    await txAs(tenantId, async (tx) => {
      await tx.insert(workspaceSettings).values({ tenantId, dealScoringEnabled: true })
        .onConflictDoUpdate({ target: workspaceSettings.tenantId, set: { dealScoringEnabled: true } });
    });

    // 1. Held deal with a past revisit date + explicit forecast omitted.
    heldId = await txAs(tenantId, async (tx) => {
      const [d] = await tx.insert(deals).values({
        tenantId, name: 'Held Selftest Deal', stage: 'hold', amountMinor: 4000, currency: 'INR',
        ownerId: OWNER, holdReason: 'timing', holdRevisitOn: '2020-01-01', forecastCategory: 'omitted',
      }).returning({ id: deals.id });
      return d!.id;
    });

    // Score freeze: recompute returns null for a held deal.
    const score = await runWithSystemContext(tenantId, () => recomputeDealScore(tenantId, heldId, new Date()));
    check('held deal freezes scoring (recompute → null)', score === null);

    // 2. Revisit-due scan creates an owner task.
    const created = await runWithSystemContext(tenantId, () => runHoldRevisitScan(tenantId));
    check('revisit scan created ≥1 task', created >= 1, `created=${created}`);
    await txAs(tenantId, async (tx) => {
      const t = await tx.select({ id: tasks.id, assignedUserId: tasks.assignedUserId }).from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.entityType, 'deal'), eq(tasks.entityId, heldId), sql`${tasks.title} LIKE 'Revisit held deal%'`));
      check('revisit task on held deal, owner-assigned', t.length === 1 && t[0]!.assignedUserId === OWNER, `n=${t.length}`);
    });

    // Idempotency: re-run creates no new task.
    await runWithSystemContext(tenantId, () => runHoldRevisitScan(tenantId));
    await txAs(tenantId, async (tx) => {
      const t = await tx.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.entityType, 'deal'), eq(tasks.entityId, heldId), sql`${tasks.title} LIKE 'Revisit held deal%'`));
      check('revisit scan is idempotent (still 1 task)', t.length === 1, `n=${t.length}`);
    });

    // 3. Forecast: a held (omitted) deal is excluded from Commit/Best-case.
    fcHeldId = await txAs(tenantId, async (tx) => {
      const [d] = await tx.insert(deals).values({
        tenantId, name: 'Held FC Deal', stage: 'hold', amountMinor: 9000, currency: 'INR', ownerId: OWNER,
        holdReason: 'timing', holdRevisitOn: '2020-02-01', forecastCategory: 'omitted', expectedCloseDate: '2020-02-15',
      }).returning({ id: deals.id });
      return d!.id;
    });
    await txAs(tenantId, async (tx) => {
      const rollup = await getForecastRollup({ tenantId, startISO: '2020-02-01', endISO: '2020-03-01', probabilities: DEFAULT_STAGE_PROBABILITY }, tx);
      check('held deal excluded from Commit', rollup.commit.rawMinor === 0, `commit=${rollup.commit.rawMinor}`);
      check('held deal excluded from Best case', rollup.bestCase.rawMinor === 0, `bestCase=${rollup.bestCase.rawMinor}`);
      check('held deal lands in omitted category', rollup.categoryTotals.omitted.amountMinor === 9000, `omitted=${rollup.categoryTotals.omitted.amountMinor}`);
    });
  } finally {
    await txAs(tenantId, async (tx) => {
      for (const id of [heldId, fcHeldId]) {
        if (!id) continue;
        await tx.delete(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.entityId, id)));
        await tx.delete(activityLogs).where(and(eq(activityLogs.tenantId, tenantId), eq(activityLogs.entityId, id)));
        await tx.delete(deals).where(and(eq(deals.id, id), eq(deals.tenantId, tenantId)));
      }
      if (priorScore === null) await tx.delete(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
      else await tx.update(workspaceSettings).set({ dealScoringEnabled: priorScore }).where(eq(workspaceSettings.tenantId, tenantId));
    });
  }

  console.log('\n─── Hold cleanup self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => { console.error('selftest fatal:', err); process.exit(1); });
