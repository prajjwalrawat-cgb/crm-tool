import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');

  const policies = (await db.execute(
    sql`SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('companies', 'contacts', 'deals', 'activity_logs', 'embeddings', 'ai_invocations', 'workflow_runs')
        ORDER BY tablename, policyname`,
  )) as unknown as Array<Record<string, unknown>>;
  for (const p of policies) {
    console.log(`${p.tablename}.${p.policyname}  cmd=${p.cmd}`);
    console.log(`  USING: ${p.qual}`);
    console.log(`  CHECK: ${p.with_check}`);
  }

  console.log('\n---- Try a soft-delete simulation under app_user role ----');
  const tenantRow = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  const tenantId = tenantRow[0]?.id ?? '00000000-0000-0000-0000-000000000000';
  console.log('  using tenantId:', tenantId);

  const contact = (await db.execute(
    sql`SELECT id FROM contacts WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  const contactId = contact[0]?.id;
  console.log('  picked contactId:', contactId);

  if (contactId) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.execute(sql`select set_config('app.user_id', 'inspect-script', true)`);
        await tx.execute(sql`select set_config('app.include_deleted', 'true', true)`);
        // Simulate the exact failing UPDATE — but with include_deleted=true.
        const r = await tx.execute(sql`
          UPDATE "contacts"
          SET "updated_at" = now(), "deleted_at" = now(), "deleted_by" = 'inspect-script'
          WHERE "contacts"."id" = ${contactId}::uuid
            AND "contacts"."tenant_id" = ${tenantId}::uuid
            AND "contacts"."deleted_at" IS NULL
          RETURNING id, deleted_at
        `);
        console.log('  UPDATE OK with include_deleted=true:', r);
        // ROLLBACK so we don't actually delete the contact.
        throw new Error('__rollback__');
      });
    } catch (err) {
      if (err instanceof Error && err.message === '__rollback__') {
        console.log('  rolled back as expected.');
      } else {
        console.log('  UPDATE failed:', err);
      }
    }
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
