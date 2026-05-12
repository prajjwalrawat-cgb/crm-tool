import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Read-only diagnostic. Lists every tenant in the DB with counts of
 * real and demo-tagged data, so we can see *exactly* where seeded rows
 * landed before touching anything destructive.
 *
 * Usage:  pnpm tsx scripts/inspect-demo-state.ts
 */

async function main() {
  const { db, client } = await import('../src/db/index');

  type TenantRow = {
    id: string;
    name: string;
    slug: string;
    clerk_org_id: string;
    created_at: Date;
    companies_total: number;
    contacts_total: number;
    deals_total: number;
    activity_demo: number;
    activity_real: number;
    workflows_demo: number;
    workflows_real: number;
  };

  const rows = (await db.execute(sql`
    SELECT
      t.id,
      t.name,
      t.slug,
      t.clerk_org_id,
      t.created_at,
      (SELECT COUNT(*)::int FROM companies      WHERE tenant_id = t.id AND deleted_at IS NULL) AS companies_total,
      (SELECT COUNT(*)::int FROM contacts       WHERE tenant_id = t.id AND deleted_at IS NULL) AS contacts_total,
      (SELECT COUNT(*)::int FROM deals          WHERE tenant_id = t.id AND deleted_at IS NULL) AS deals_total,
      (SELECT COUNT(*)::int FROM activity_logs  WHERE tenant_id = t.id AND metadata->>'demoSeed' = 'true') AS activity_demo,
      (SELECT COUNT(*)::int FROM activity_logs  WHERE tenant_id = t.id AND (metadata->>'demoSeed') IS DISTINCT FROM 'true') AS activity_real,
      (SELECT COUNT(*)::int FROM workflow_runs  WHERE tenant_id = t.id AND metadata->>'demoSeed' = 'true') AS workflows_demo,
      (SELECT COUNT(*)::int FROM workflow_runs  WHERE tenant_id = t.id AND (metadata->>'demoSeed') IS DISTINCT FROM 'true') AS workflows_real
    FROM tenants t
    ORDER BY t.created_at ASC
  `)) as unknown as TenantRow[];

  console.log(`tenants: ${rows.length}\n`);

  // Markdown-style table for legibility.
  for (const r of rows) {
    const demoEntities = await db.execute(sql`
      SELECT entity_type, COUNT(*)::int AS n
      FROM activity_logs
      WHERE tenant_id = ${r.id}::uuid
        AND metadata->>'demoSeed' = 'true'
        AND action = 'created'
      GROUP BY entity_type
    `) as unknown as Array<{ entity_type: string; n: number }>;

    const demoCounts = {
      company: 0,
      contact: 0,
      deal: 0,
      ...Object.fromEntries(demoEntities.map((e) => [e.entity_type, e.n])),
    };

    const marker =
      r.activity_demo + r.workflows_demo > 0 ? '⚠ DEMO DATA' : '·';
    console.log(`${marker}  ${r.name}`);
    console.log(`     id:               ${r.id}`);
    console.log(`     slug:             ${r.slug}`);
    console.log(`     clerk_org_id:     ${r.clerk_org_id}`);
    console.log(`     created_at:       ${new Date(r.created_at).toISOString()}`);
    console.log(`     companies total:  ${r.companies_total}`);
    console.log(`     contacts  total:  ${r.contacts_total}`);
    console.log(`     deals     total:  ${r.deals_total}`);
    console.log(
      `     activity:  demo=${r.activity_demo}  real=${r.activity_real}`,
    );
    console.log(
      `     workflows: demo=${r.workflows_demo}  real=${r.workflows_real}`,
    );
    console.log(
      `     demo-tagged created rows: companies=${demoCounts.company} contacts=${demoCounts.contact} deals=${demoCounts.deal}`,
    );
    console.log('');
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('inspect fatal:', err);
  process.exit(1);
});
