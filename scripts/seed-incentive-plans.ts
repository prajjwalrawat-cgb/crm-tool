import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Seed three sample incentive plans — one per mechanic the default plan
 * doesn't exercise (a cap that bites, a 'nil' margin miss, full-step-only
 * accrual) — with manual actuals, for the current fiscal year.
 *
 *   pnpm seed:incentives --tenant=<uuid>
 *   pnpm seed:incentives --tenant=<uuid> --users=user_a,user_b,user_c
 *
 * Without --users, the first three member/manager memberships are used
 * (falling back to the Test 1 seed personas when the tenant has fewer).
 *
 * Writes go through the same `createPlan` / `recordManualActuals` the app
 * uses, so each seeded plan has its v1 audit row like any other. Idempotent:
 * a resource who already has a plan for the year is skipped, not changed.
 *
 * The shapes and their expected payouts are in src/lib/incentives/seed-shapes
 * and hand-checked in selftest-incentives.
 */

const SEED_PERSONA_FALLBACK = ['seed-actor-priya-sharma', 'seed-actor-rahul-mehta', 'seed-actor-meera-iyer'];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  const tenantId = arg('tenant');
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
    console.error('Usage: pnpm seed:incentives --tenant=<uuid> [--users=a,b,c]');
    process.exit(1);
  }
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { createPlan, recordManualActuals } = await import('../src/lib/incentives/mutations');
  const { SEED_PLAN_SHAPES } = await import('../src/lib/incentives/seed-shapes');
  const { toStoredTerms } = await import('../src/lib/incentives/terms');
  const { calculateIncentive } = await import('../src/lib/incentives/engine');
  const { currentFiscalYear, fiscalYearLabel } = await import('../src/lib/targets/fiscal');

  try {
    const [settings] = (await db.execute(sql`
      SELECT fiscal_year_start_month FROM organization_settings WHERE tenant_id = ${tenantId}::uuid
    `)) as unknown as Array<{ fiscal_year_start_month: number }>;
    const startMonth = settings?.fiscal_year_start_month ?? 1;
    const fy = currentFiscalYear(startMonth, new Date());

    let users = arg('users')?.split(',').map((u) => u.trim()).filter(Boolean) ?? [];
    if (users.length === 0) {
      const rows = (await db.execute(sql`
        SELECT user_id FROM memberships
        WHERE tenant_id = ${tenantId}::uuid AND role IN ('member', 'manager') AND status = 'active'
        ORDER BY created_at LIMIT 3
      `)) as unknown as Array<{ user_id: string }>;
      users = rows.map((r) => r.user_id);
      for (const p of SEED_PERSONA_FALLBACK) if (users.length < 3 && !users.includes(p)) users.push(p);
    }

    console.log(`Seeding ${fiscalYearLabel(startMonth, fy)} incentive plans into ${tenantId}`);
    await runWithSystemContext(tenantId, async () => {
      for (let i = 0; i < SEED_PLAN_SHAPES.length && i < users.length; i++) {
        const shape = SEED_PLAN_SHAPES[i]!;
        const userId = users[i]!;
        const res = await createPlan({
          tenantId,
          actorId: 'system',
          userId,
          fiscalYear: fy,
          terms: toStoredTerms(shape.terms),
          status: 'active',
          actualsSource: 'manual',
        });
        if (!res.ok) {
          console.log(`  ${userId}: skipped — ${res.message}`);
          continue;
        }
        await recordManualActuals({
          tenantId,
          actorId: 'system',
          planId: res.value.planId,
          asOfDate: new Date().toISOString().slice(0, 10),
          priorYearRevenueCr: String(shape.actuals.priorYearRevenueCr),
          netNewRevenueCr: String(shape.actuals.netNewRevenueCr),
          blendedMarginPct: String(shape.actuals.blendedMarginPct),
        });
        const r = calculateIncentive(shape.terms, shape.actuals);
        console.log(
          `  ${userId}: ${shape.label} — credited ₹${r.creditedRevenue} Cr, gross ₹${r.grossIncentive} L, payout ₹${r.finalPayoutL} L`,
        );
      }
    });
    console.log('done.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed fatal:', err);
  process.exit(1);
});
