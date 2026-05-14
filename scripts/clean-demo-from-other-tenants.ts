import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

import { DEMO_TENANT_NAMES } from './demo-allowlist';

config({ path: '.env.local' });
config();

/**
 * Remove every demo/stress/seeded row from tenants that are NOT on the
 * demo allowlist (`scripts/demo-allowlist.ts`). Real user-created data
 * is preserved — the script only deletes rows that carry one of our
 * known seed markers:
 *
 *   - activity_logs.metadata->>'demoSeed' = 'true'    (seed-demo-data.ts)
 *   - activity_logs.metadata->>'seedRun' IS NOT NULL  (seed-stress-data.ts)
 *   - activity_logs.metadata->>'seedDemo' = 'true'    (CP#9+ tables)
 *   - actor / author / creator / recipient IDs LIKE 'seed-actor-%' or = 'demo-seed'
 *   - workflow_runs.metadata->>'demoSeed' = 'true'
 *   - email_messages.metadata->>'seedDemo' = 'true'
 *
 * Companies / contacts / deals are identified through their creation
 * activity_log row. If a row has no creation log (e.g. created via the
 * UI before this convention existed), it is NOT touched.
 *
 * Usage:
 *   pnpm tsx scripts/clean-demo-from-other-tenants.ts            // dry run by default
 *   pnpm tsx scripts/clean-demo-from-other-tenants.ts --execute  // perform deletes
 */

const EXECUTE =
  process.argv.includes('--execute') || process.env.EXECUTE === '1';

async function main() {
  const { db, client } = await import('../src/db/index');

  type TenantRow = { id: string; name: string };

  // Tenants NOT on the allowlist — these are the ones we will clean.
  // sql.join with comma-separated params dodges the array literal issue
  // postgres-js hits when binding a JS string[] to text[].
  const allowParams =
    DEMO_TENANT_NAMES.length === 0
      ? sql`''`
      : sql.join(
          DEMO_TENANT_NAMES.map((n) => sql`${n}`),
          sql`, `,
        );
  const targets = (await db.execute(sql`
    SELECT id, name
    FROM tenants
    WHERE name NOT IN (${allowParams})
    ORDER BY created_at ASC
  `)) as unknown as TenantRow[];

  if (targets.length === 0) {
    console.log('No tenants outside the demo allowlist. Nothing to do.');
    await client.end({ timeout: 5 });
    return;
  }

  console.log(
    `${EXECUTE ? 'EXECUTING' : 'DRY RUN'} — will ${EXECUTE ? '' : 'NOT '}` +
      `delete demo/stress rows from ${targets.length} tenant(s):`,
  );
  for (const t of targets) console.log(`  - ${t.name} (${t.id})`);
  console.log('');

  // Per-tenant audit + (optional) deletion.
  for (const t of targets) {
    console.log(`tenant "${t.name}" (${t.id}):`);

    // Audit counts.
    type C = { n: number };
    const seedActivity = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM activity_logs
      WHERE tenant_id = ${t.id}::uuid
        AND (
          metadata->>'demoSeed' = 'true'
          OR (metadata->>'seedRun') IS NOT NULL
          OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
        )
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedWorkflows = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM workflow_runs
      WHERE tenant_id = ${t.id}::uuid
        AND metadata->>'demoSeed' = 'true'
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedDeals = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM deals
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'deal'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedContacts = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM contacts
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'contact'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedCompanies = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM companies
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'company'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `)) as unknown as C[])[0]?.n ?? 0;

    // Newer tables (CP#9 onward) carry seed-actor IDs or `seedDemo` flags
    // directly. Tasks/notes/comments/notifications/emails are not anchored
    // by activity_log rows, so we count them straight from each table.
    const seedTasks = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM tasks
      WHERE tenant_id = ${t.id}::uuid
        AND (created_by LIKE 'seed-actor-%' OR created_by = 'demo-seed')
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedNotes = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM notes
      WHERE tenant_id = ${t.id}::uuid
        AND (author_user_id LIKE 'seed-actor-%' OR author_user_id = 'demo-seed')
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedComments = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM comments
      WHERE tenant_id = ${t.id}::uuid
        AND author_user_id LIKE 'seed-actor-%'
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedNotifs = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM notifications
      WHERE tenant_id = ${t.id}::uuid
        AND recipient_user_id LIKE 'seed-actor-%'
    `)) as unknown as C[])[0]?.n ?? 0;

    const seedEmails = ((await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM email_messages
      WHERE tenant_id = ${t.id}::uuid
        AND (
          actor_user_id LIKE 'seed-actor-%'
          OR metadata->>'seedDemo' = 'true'
        )
    `)) as unknown as C[])[0]?.n ?? 0;

    console.log(
      `  to delete:  companies=${seedCompanies} contacts=${seedContacts} deals=${seedDeals} activity=${seedActivity} workflows=${seedWorkflows} tasks=${seedTasks} notes=${seedNotes} comments=${seedComments} notifs=${seedNotifs} emails=${seedEmails}`,
    );

    if (
      seedActivity === 0 &&
      seedWorkflows === 0 &&
      seedDeals === 0 &&
      seedContacts === 0 &&
      seedCompanies === 0 &&
      seedTasks === 0 &&
      seedNotes === 0 &&
      seedComments === 0 &&
      seedNotifs === 0 &&
      seedEmails === 0
    ) {
      console.log('  (nothing to clean)\n');
      continue;
    }

    if (!EXECUTE) {
      console.log('  [skipped — dry run]\n');
      continue;
    }

    // Delete order: entities first (FKs on activity_log are by tenant
    // only, so no constraint forces a particular order here), then the
    // tagged activity rows themselves, then workflow runs.
    await db.execute(sql`
      DELETE FROM deals
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'deal'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `);
    await db.execute(sql`
      DELETE FROM contacts
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'contact'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `);
    await db.execute(sql`
      DELETE FROM companies
      WHERE tenant_id = ${t.id}::uuid
        AND id IN (
          SELECT entity_id::uuid
          FROM activity_logs
          WHERE tenant_id = ${t.id}::uuid
            AND entity_type = 'company'
            AND (
              metadata->>'demoSeed' = 'true'
              OR (metadata->>'seedRun') IS NOT NULL
              OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
            )
        )
    `);
    await db.execute(sql`
      DELETE FROM activity_logs
      WHERE tenant_id = ${t.id}::uuid
        AND (
          metadata->>'demoSeed' = 'true'
          OR (metadata->>'seedRun') IS NOT NULL
          OR (actor_user_id IN ('seed-stress-data', 'demo-seed') OR actor_user_id LIKE 'seed-actor-%')
        )
    `);
    await db.execute(sql`
      DELETE FROM workflow_runs
      WHERE tenant_id = ${t.id}::uuid
        AND metadata->>'demoSeed' = 'true'
    `);
    await db.execute(sql`
      DELETE FROM email_messages
      WHERE tenant_id = ${t.id}::uuid
        AND (
          actor_user_id LIKE 'seed-actor-%'
          OR metadata->>'seedDemo' = 'true'
        )
    `);
    await db.execute(sql`
      DELETE FROM notifications
      WHERE tenant_id = ${t.id}::uuid
        AND recipient_user_id LIKE 'seed-actor-%'
    `);
    await db.execute(sql`
      DELETE FROM comments
      WHERE tenant_id = ${t.id}::uuid
        AND author_user_id LIKE 'seed-actor-%'
    `);
    await db.execute(sql`
      DELETE FROM notes
      WHERE tenant_id = ${t.id}::uuid
        AND (author_user_id LIKE 'seed-actor-%' OR author_user_id = 'demo-seed')
    `);
    await db.execute(sql`
      DELETE FROM tasks
      WHERE tenant_id = ${t.id}::uuid
        AND (created_by LIKE 'seed-actor-%' OR created_by = 'demo-seed')
    `);

    console.log('  cleaned.\n');
  }

  if (!EXECUTE) {
    console.log(
      'Dry run complete. Re-run with --execute to actually delete the rows.',
    );
  } else {
    console.log('Cleanup complete.');
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('clean fatal:', err);
  process.exit(1);
});
