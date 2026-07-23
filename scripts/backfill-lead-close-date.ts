import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * One-time fix for the "a dated deal can't be in Lead" business rule: move every
 * existing Lead-stage deal that already has an expected close date up to
 * Qualified. Idempotent (only touches Lead rows). The deal_stage_history trigger
 * records each transition automatically.
 *
 *   pnpm tsx scripts/backfill-lead-close-date.ts
 */
async function main() {
  const { db, client } = await import('../src/db/index');

  const before = (await db.execute(sql`
    SELECT count(*)::int AS n FROM deals
    WHERE stage = 'lead' AND expected_close_date IS NOT NULL AND deleted_at IS NULL
  `)) as unknown as Array<{ n: number }>;
  const n = before[0]?.n ?? 0;
  console.log(`found ${n} Lead deal(s) with a close date.`);

  if (n > 0) {
    await db.execute(sql`
      UPDATE deals
      SET stage = 'qualified', updated_at = now(), updated_by = 'system'
      WHERE stage = 'lead' AND expected_close_date IS NOT NULL AND deleted_at IS NULL
    `);
    console.log(`moved ${n} deal(s) from Lead → Qualified.`);
  }

  console.log('done.');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('backfill fatal:', err);
  process.exit(1);
});
