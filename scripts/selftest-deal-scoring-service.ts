import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the Module 2 scoring SERVICE (recomputeDealScore):
 * persistence to deal_scores, the deals cache columns, the flag gate, and the
 * "log a call raises the score" recompute path. Complements the pure-function
 * unit test (selftest-deal-scoring.ts).
 *
 * Uses the server-only shim (run via the `selftest` npm script). Snapshots +
 * restores the DEAL_SCORING flag and deletes every row it creates.
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
  const { workspaceSettings, deals, dealScores, activityLogs } = await import(
    '../src/db/schema'
  );
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { recomputeDealScore } = await import('../src/lib/deals/scoring/service');

  async function txAs<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'selftest-score', true)`);
      return fn(tx);
    });
  }

  const rows = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as TenantRow[];
  if (rows.length === 0) {
    console.error('No tenants found.');
    process.exit(2);
  }
  const tenantId = rows[0]!.id;
  console.log(`tenant=${tenantId}`);

  const priorFlag = await txAs(tenantId, async (tx) => {
    const r = await tx
      .select({ e: workspaceSettings.dealScoringEnabled })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId));
    return r[0]?.e ?? null;
  });

  let dealId = '';
  try {
    await txAs(tenantId, async (tx) => {
      await tx
        .insert(workspaceSettings)
        .values({ tenantId, dealScoringEnabled: true })
        .onConflictDoUpdate({
          target: workspaceSettings.tenantId,
          set: { dealScoringEnabled: true },
        });
    });

    // A stale deal: amount 0, no activity, no stakeholders.
    dealId = await txAs(tenantId, async (tx) => {
      const [d] = await tx
        .insert(deals)
        .values({ tenantId, name: 'Score Service Selftest', stage: 'qualified', amountMinor: 0, currency: 'INR' })
        .returning({ id: deals.id });
      return d!.id;
    });

    // First recompute (system context, real service).
    const first = await runWithSystemContext(tenantId, () =>
      recomputeDealScore(tenantId, dealId, new Date()),
    );
    check('recompute returns a score row', first != null && typeof first.score === 'number', `score=${first?.score}`);
    check('band is at_risk for a dead deal', first?.band === 'at_risk', `band=${first?.band}`);

    // deals cache column refreshed.
    await txAs(tenantId, async (tx) => {
      const [d] = await tx
        .select({ hs: deals.healthScore, hb: deals.healthBand })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      check('deals cache updated', d?.hs === first?.score && d?.hb === first?.band, `cache=${d?.hs}/${d?.hb}`);
    });

    // Log a genuine activity (call) → recompute → score should rise.
    await txAs(tenantId, async (tx) => {
      await tx.insert(activityLogs).values({
        tenantId, actorUserId: 'selftest-score', entityType: 'deal', entityId: dealId, action: 'call_logged', metadata: {},
      });
    });
    const second = await runWithSystemContext(tenantId, () =>
      recomputeDealScore(tenantId, dealId, new Date()),
    );
    check('logging a call raises the score', (second?.score ?? 0) > (first?.score ?? 0), `${first?.score} -> ${second?.score}`);

    // Append-only history: at least 2 rows now.
    await txAs(tenantId, async (tx) => {
      const hist = await tx
        .select({ id: dealScores.id })
        .from(dealScores)
        .where(and(eq(dealScores.tenantId, tenantId), eq(dealScores.dealId, dealId)));
      check('history is append-only (≥2 rows)', hist.length >= 2, `rows=${hist.length}`);
    });

    // Reasons explain deviation: 50 + sum(deltas) is within clamp of score.
    check(
      'reasons present',
      Array.isArray(second?.reasons) && second!.reasons.length > 0,
    );

    // Flag OFF → recompute is a no-op (returns null).
    await txAs(tenantId, async (tx) => {
      await tx.update(workspaceSettings).set({ dealScoringEnabled: false }).where(eq(workspaceSettings.tenantId, tenantId));
    });
    const off = await runWithSystemContext(tenantId, () =>
      recomputeDealScore(tenantId, dealId, new Date()),
    );
    check('flag off → no-op recompute', off === null);
  } finally {
    await txAs(tenantId, async (tx) => {
      if (dealId) {
        await tx.delete(dealScores).where(eq(dealScores.dealId, dealId));
        await tx.delete(activityLogs).where(and(eq(activityLogs.tenantId, tenantId), eq(activityLogs.entityId, dealId)));
        await tx.delete(deals).where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
      }
      if (priorFlag === null) {
        await tx.delete(workspaceSettings).where(eq(workspaceSettings.tenantId, tenantId));
      } else {
        await tx.update(workspaceSettings).set({ dealScoringEnabled: priorFlag }).where(eq(workspaceSettings.tenantId, tenantId));
      }
    });
  }

  console.log('\n─── Deal-scoring service self-test ───');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
