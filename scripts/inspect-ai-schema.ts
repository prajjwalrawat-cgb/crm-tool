import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * One-off inspector for the ai_invocations / ai_summaries / embeddings
 * tables: confirms columns, types, RLS state, grants, and whether the
 * raw-SQL aggregate query the ops dashboard uses actually runs against
 * the connection's effective role.
 */
async function main() {
  const { db, client } = await import('../src/db/index');

  console.log('---- pg_class entries ----');
  const tables = (await db.execute(
    sql`SELECT
          c.relname AS table_name,
          n.nspname AS schema,
          c.relrowsecurity AS rls_enabled,
          c.relforcerowsecurity AS rls_forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname IN ('ai_invocations', 'ai_summaries', 'embeddings')
        ORDER BY c.relname`,
  )) as unknown as Array<{
    table_name: string;
    schema: string;
    rls_enabled: boolean;
    rls_forced: boolean;
  }>;
  console.table(tables);

  console.log('\n---- columns of ai_invocations ----');
  const cols = (await db.execute(
    sql`SELECT column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_invocations'
        ORDER BY ordinal_position`,
  )) as unknown as Array<Record<string, unknown>>;
  console.table(cols);

  console.log('\n---- pg_type enums named like *status* ----');
  const enums = (await db.execute(
    sql`SELECT t.typname, e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname ILIKE '%status%' OR t.typname ILIKE '%kind%'
        ORDER BY t.typname, e.enumsortorder`,
  )) as unknown as Array<Record<string, unknown>>;
  console.table(enums);

  console.log('\n---- grants for app_user on ai_invocations ----');
  const grants = (await db.execute(
    sql`SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'ai_invocations'
          AND grantee IN ('app_user', 'postgres', 'public')
        ORDER BY grantee, privilege_type`,
  )) as unknown as Array<Record<string, unknown>>;
  console.table(grants);

  console.log('\n---- distinct status values currently in ai_invocations ----');
  const statuses = (await db.execute(
    sql`SELECT status, COUNT(*)::int AS n FROM ai_invocations GROUP BY status ORDER BY n DESC`,
  )) as unknown as Array<Record<string, unknown>>;
  console.table(statuses);

  console.log('\n---- reproduce failing aggregate from ops queries (postgres role) ----');
  const tenantId =
    (process.env.TEST_TENANT_ID ??
      ((await db.execute(
        sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
      )) as unknown as Array<{ id: string }>)[0]?.id) ??
    '00000000-0000-0000-0000-000000000000';
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const out = await db.execute(sql`
      SELECT
        COUNT(*)::int            AS total,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success,
        COUNT(*) FILTER (WHERE status = 'error')::int   AS error,
        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
        COALESCE(SUM(total_tokens), 0)::int             AS tokens
      FROM ai_invocations
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${since}
    `);
    console.log('postgres role (no SET LOCAL ROLE):', out);
  } catch (err) {
    console.log('postgres role failed:', err);
  }

  console.log('\n---- same query but inside transaction with set local role app_user ----');
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'inspect-script', true)`);

      // 1) UNQUOTED  — the form ops/queries.ts used
      try {
        const a = await tx.execute(sql`
          SELECT COUNT(*)::int AS n FROM ai_invocations
          WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${since}
        `);
        console.log('  unquoted FROM ai_invocations OK:', a);
      } catch (err) {
        console.log('  unquoted FROM ai_invocations FAILED:', err);
      }

      // 2) QUOTED  — what Drizzle's .select(...).from(aiInvocations) emits
      try {
        const b = await tx.execute(sql`
          SELECT COUNT(*)::int AS n FROM "ai_invocations"
          WHERE "tenant_id" = ${tenantId}::uuid AND "created_at" >= ${since}
        `);
        console.log('  quoted   FROM "ai_invocations" OK:', b);
      } catch (err) {
        console.log('  quoted   FROM "ai_invocations" FAILED:', err);
      }

      // 3) UNQUOTED but explicit public.
      try {
        const c = await tx.execute(sql`
          SELECT COUNT(*)::int AS n FROM public.ai_invocations
          WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${since}
        `);
        console.log('  schema-qualified public.ai_invocations OK:', c);
      } catch (err) {
        console.log('  schema-qualified public.ai_invocations FAILED:', err);
      }

      // 4) check what app_user's search_path is right now
      const sp = (await tx.execute(
        sql`SELECT current_setting('search_path') AS sp, current_user AS who`,
      )) as unknown as Array<{ sp: string; who: string }>;
      console.log('  search_path / current_user:', sp[0]);
    });
  } catch (err) {
    console.log('outer transaction errored:', err);
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
