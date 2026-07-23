import { config } from 'dotenv';

config({ path: '.env.local' });
config();

/**
 * Backfill Module 2 health scores for every open deal in every workspace that
 * has DEAL_SCORING_ENABLED on. Idempotent — appends one fresh deal_scores row
 * per deal and refreshes the deals cache. Safe to re-run.
 *
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/backfill-deal-scores.ts
 */
async function main() {
  const { db, client } = await import('../src/db/index');
  const { tenants } = await import('../src/db/schema');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { recomputeOpenDealsForTenant } = await import(
    '../src/lib/deals/scoring/service'
  );

  const allTenants = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
  let total = 0;
  for (const t of allTenants) {
    const { scored } = await runWithSystemContext(t.id, () =>
      recomputeOpenDealsForTenant(t.id),
    );
    if (scored > 0) {
      console.log(`  ${t.name} (${t.id}): scored ${scored} deal(s)`);
      total += scored;
    }
  }
  console.log(`done. scored ${total} deal(s) across ${allTenants.length} tenant(s).`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('backfill fatal:', err);
  process.exit(1);
});
