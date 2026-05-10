import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * One-shot diagnostic to confirm the role the active dashboard user
 * actually carries in the memberships table. Helps explain "I see the
 * page but no Restore button" — the page text said "Owners can
 * restore" while their actual role is something else.
 */
async function main() {
  const { db, client } = await import('../src/db/index');

  console.log('---- memberships across all tenants ----');
  const rows = (await db.execute(
    sql`SELECT m.tenant_id, t.name AS tenant_name, m.user_id, m.role, m.status, m.created_at
        FROM memberships m
        JOIN tenants t ON t.id = m.tenant_id
        ORDER BY t.created_at, m.role, m.created_at`,
  )) as unknown as Array<{
    tenant_id: string;
    tenant_name: string;
    user_id: string;
    role: string;
    status: string;
    created_at: string;
  }>;
  for (const r of rows) {
    console.log(
      `  tenant=${r.tenant_name.padEnd(20)}  user=${r.user_id}  role=${r.role.padEnd(7)}  status=${r.status}`,
    );
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
