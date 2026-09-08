import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Manual deal-risk pass.
 *
 *   pnpm risk:score               # every tenant, explanations on
 *   pnpm risk:score -- --no-explain
 *
 * Runs the SAME `scoreTenant` the nightly cron runs. Use it to seed scores
 * on a fresh deployment (until the first cron fires, no deal has a score and
 * the At Risk view is honestly empty) or to re-score after changing the
 * rubric.
 */
async function main() {
  const noExplain = process.argv.includes('--no-explain');
  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { recomputeTenantRisk } = await import('../src/lib/deals/risk/runner');

  const tenants = (await db.execute(
    sql`SELECT id, name FROM tenants ORDER BY name`,
  )) as unknown as Array<{ id: string; name: string }>;

  for (const t of tenants) {
    const r = await runWithSystemContext(t.id, () =>
      recomputeTenantRisk(t.id, { explain: !noExplain }),
    );
    if (r.scored === 0 && r.pruned === 0) continue;
    console.log(
      `${t.name}: scored ${r.scored}, pruned ${r.pruned}, explained ${r.explained}` +
        (r.deferred > 0 ? `, ${r.deferred} deferred to the next run` : '') +
        (r.explainerAvailable ? '' : '  [no ANTHROPIC_API_KEY - rubric sentences only]'),
    );
  }
  await client.end?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
