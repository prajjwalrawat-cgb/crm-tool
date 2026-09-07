import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Manual month-close snapshot of the Team Performance scorecard.
 *
 *   pnpm snapshot:team-metrics                 # capture last month
 *   pnpm snapshot:team-metrics -- --period=2026-08
 *
 * Runs the SAME `snapshotTenant` the monthly cron runs, so a hand-seeded
 * baseline and a cron-written one are byte-identical. Upserts, so re-running
 * a period overwrites it rather than doubling it.
 *
 * Use it to seed a first baseline (until one exists the page honestly shows
 * "no comparison yet" on every tile) or to backfill a period a failed cron
 * run missed.
 */
async function main() {
  const periodArg = process.argv.find((a) => a.startsWith('--period='));
  const period = periodArg ? periodArg.split('=')[1] : undefined;
  if (period && !/^\d{4}-\d{2}$/.test(period)) {
    console.error(`bad --period=${period}; expected YYYY-MM`);
    process.exit(1);
  }

  const { db, client } = await import('../src/db/index');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { snapshotTenant } = await import(
    '../src/lib/inngest/workflows/team-metrics-monthly'
  );

  const tenants = (await db.execute(
    sql`SELECT id, name FROM tenants ORDER BY name`,
  )) as unknown as Array<{ id: string; name: string }>;

  const now = new Date();
  for (const t of tenants) {
    const rows = await runWithSystemContext(t.id, () =>
      snapshotTenant(t.id, t.name, now, period),
    );
    console.log(`${t.name}: ${rows} rows${period ? ` for ${period}` : ''}`);
  }
  await client.end?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
