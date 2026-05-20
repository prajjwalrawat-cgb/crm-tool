import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * One-shot backfill that walks every tenant and stitches existing
 * `email_messages` rows into `communication_threads`.
 *
 * Safe to re-run. Each message is processed in its own transaction
 * so a single bad row doesn't abort the rest.
 *
 * Usage:
 *   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/backfill-communications-threads.ts
 */
async function main() {
  const { db, client } = await import('../src/db/index');
  const { backfillThreadsForTenant } = await import(
    '../src/lib/communications/threads/backfill'
  );

  const tenants = (await db.execute(sql`
    SELECT id::text AS id, name FROM tenants ORDER BY created_at ASC
  `)) as unknown as Array<{ id: string; name: string }>;

  console.log(`backfilling ${tenants.length} tenant(s)...`);

  let totalStats = {
    totalProcessed: 0,
    threadsCreated: 0,
    threadsReused: 0,
    errors: 0,
  };

  for (const t of tenants) {
    const stats = await backfillThreadsForTenant(t.id);
    console.log(
      `  [${t.name}] processed=${stats.totalProcessed} created=${stats.threadsCreated} reused=${stats.threadsReused} errors=${stats.errors}`,
    );
    totalStats.totalProcessed += stats.totalProcessed;
    totalStats.threadsCreated += stats.threadsCreated;
    totalStats.threadsReused += stats.threadsReused;
    totalStats.errors += stats.errors;
  }

  console.log('totals:', totalStats);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('backfill fatal:', err);
  process.exit(1);
});
