import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

import { UUID_REGEX_LITERAL } from '../src/lib/db-sql/safe-uuid';

config({ path: '.env.local' });
config();

/**
 * Smoke-test the SQL hotfix: run the guarded CTEs against the live DB
 * and confirm they don't throw. Returns row counts so we can also see
 * whether the regex filter actually drops non-UUID rows in real data.
 */
async function main() {
  const { db, client } = await import('../src/db/index');

  // Pick the first tenant id so the queries have something realistic
  // to scan. Using a hard-coded uuid would just return zero rows.
  const tenantRows = (await db.execute(sql`
    SELECT id::text AS id FROM tenants ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) {
    console.log('No tenants in DB — cannot smoke-test. Skipping.');
    await client.end({ timeout: 5 });
    return;
  }
  console.log(`smoke testing against tenant ${tenantId}`);

  // 1) Risk-flag CTE (last_act) — guarded regex on entity_id.
  const lastActRows = (await db.execute(sql`
    WITH last_act AS (
      SELECT entity_id::uuid AS deal_id, max(created_at) AS at
      FROM activity_logs
      WHERE tenant_id = ${tenantId}::uuid
        AND entity_type = 'deal'
        AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
      GROUP BY entity_id
    )
    SELECT count(*)::int AS n FROM last_act
  `)) as unknown as Array<{ n: number }>;
  console.log(`  [risk-flag last_act] ${lastActRows[0]?.n ?? 0} rows`);

  // 2) Stale-deals CTE.
  const staleRows = (await db.execute(sql`
    WITH last_stage AS (
      SELECT entity_id::uuid AS deal_id, max(created_at) AS at
      FROM activity_logs
      WHERE tenant_id = ${tenantId}::uuid
        AND entity_type = 'deal'
        AND action = 'stage_changed'
        AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
      GROUP BY entity_id
    )
    SELECT count(*)::int AS n FROM last_stage
  `)) as unknown as Array<{ n: number }>;
  console.log(`  [stale-deals last_stage] ${staleRows[0]?.n ?? 0} rows`);

  // 3) Deal-velocity stage_events.
  const velRows = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM activity_logs al
    WHERE al.tenant_id = ${tenantId}::uuid
      AND al.entity_type = 'deal'
      AND al.action = 'stage_changed'
      AND al.entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
  `)) as unknown as Array<{ n: number }>;
  console.log(`  [deal-velocity stage_events] ${velRows[0]?.n ?? 0} rows`);

  // 4) Sanity check the regex against KNOWN non-UUID values.
  const sanity = (await db.execute(sql`
    SELECT
      ('user_abc123def456'                       ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)})::text AS non_uuid_clerk,
      ('orginv_xyz789'                            ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)})::text AS non_uuid_invitation,
      ('11111111-2222-3333-4444-555555555555'    ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)})::text AS uuid
  `)) as unknown as Array<{
    non_uuid_clerk: string;
    non_uuid_invitation: string;
    uuid: string;
  }>;
  console.log('  [regex sanity check]', sanity[0]);

  console.log('done. no errors thrown.');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('smoke fatal:', err);
  process.exit(1);
});
