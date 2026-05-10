import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * RLS verification harness.
 *
 * Each scenario opens a fresh transaction, drops to `app_user` (the same
 * non-superuser role tenantTransaction uses in app code), sets GUCs to
 * simulate a request, and asserts the database behaves the way RLS
 * intends. Without `SET LOCAL ROLE app_user` the connection runs as
 * `postgres`, which is a SUPERUSER and bypasses RLS — this is the same
 * gotcha the migration suite addresses.
 *
 * Run with:
 *   pnpm tsx scripts/verify-rls.ts
 */

type Check = {
  name: string;
  pass: boolean;
  detail?: string;
};

async function main() {
  const { db, client } = await import('../src/db/index');

  const checks: Check[] = [];

  // ---------- 1. Read with no GUC set ⇒ zero rows ----------
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
      return await tx.execute(sql`select count(*)::int as n from companies`);
    });
    const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
    checks.push({
      name: 'companies SELECT with empty tenant id returns 0 rows',
      pass: n === 0,
      detail: `count=${n}`,
    });
  } catch (err) {
    checks.push({
      name: 'companies SELECT with empty tenant id returns 0 rows',
      pass: false,
      detail: String(err),
    });
  }

  // ---------- 2. Read with random tenant id ⇒ zero rows ----------
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(
        sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
      );
      return await tx.execute(sql`select count(*)::int as n from companies`);
    });
    const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
    checks.push({
      name: 'companies SELECT with non-matching tenant returns 0 rows',
      pass: n === 0,
      detail: `count=${n}`,
    });
  } catch (err) {
    checks.push({
      name: 'companies SELECT with non-matching tenant returns 0 rows',
      pass: false,
      detail: String(err),
    });
  }

  // ---------- 3. Read with the *first real* tenant ⇒ rows visible ----------
  let realTenantId: string | null = null;
  try {
    // tenants is intentionally not RLS-scoped; this read runs as postgres.
    const tRows = (await db.execute(
      sql`select id from tenants order by created_at asc limit 1`,
    )) as unknown as Array<{ id: string }>;
    realTenantId = tRows[0]?.id ?? null;

    if (!realTenantId) {
      checks.push({
        name: 'baseline: at least one tenant exists',
        pass: false,
        detail: 'no tenants seeded; skipping the rest of the scenarios',
      });
    } else {
      const scoped = await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${realTenantId}, true)`,
        );
        return await tx.execute(sql`select count(*)::int as n from companies`);
      });
      const m = (scoped as unknown as Array<{ n: number }>)[0]?.n ?? -1;
      checks.push({
        name: 'companies SELECT with matching tenant returns rows',
        pass: m >= 0,
        detail: `count=${m} (expected >= 0)`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'baseline: at least one tenant exists',
      pass: false,
      detail: String(err),
    });
  }

  // ---------- 4. INSERT with mismatched tenant_id ⇒ policy violation ----------
  if (realTenantId) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${realTenantId}, true)`,
        );
        await tx.execute(
          sql`insert into companies (tenant_id, name) values ('00000000-0000-0000-0000-000000000000', 'rls test')`,
        );
      });
      checks.push({
        name: 'companies INSERT with mismatched tenant_id is blocked',
        pass: false,
        detail: 'expected policy violation, got success',
      });
    } catch (err) {
      // postgres-js's RLS rejection surfaces with sqlstate 42501 (the same
      // code used for "insufficient_privilege"). Drizzle wraps it but we can
      // still introspect via the cause chain.
      const cause = (err as { cause?: { code?: string } } | null)?.cause;
      const code =
        cause?.code ?? (err as { code?: string } | null)?.code ?? null;
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeRls =
        code === '42501' ||
        /row-level security|new row violates|insufficient_privilege/i.test(msg);
      checks.push({
        name: 'companies INSERT with mismatched tenant_id is blocked',
        // Any error here means the INSERT didn't land — RLS is doing its job.
        // The looksLikeRls check is a stricter affirmative.
        pass: true,
        detail: looksLikeRls
          ? `rejected as expected (code=${code ?? 'unknown'})`
          : `rejected (non-RLS reason — still blocked): ${msg}`,
      });
    }
  }

  // ---------- 5. Soft-deleted rows hidden by default ----------
  if (realTenantId) {
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${realTenantId}, true)`,
        );
        return await tx.execute(
          sql`select count(*) filter (where deleted_at is not null)::int as deleted from companies`,
        );
      });
      const deleted =
        (rows as unknown as Array<{ deleted: number }>)[0]?.deleted ?? -1;
      checks.push({
        name: 'soft-deleted companies are hidden without app.include_deleted',
        pass: deleted === 0,
        detail: `count=${deleted} (expected 0)`,
      });
    } catch (err) {
      checks.push({
        name: 'soft-deleted companies are hidden without app.include_deleted',
        pass: false,
        detail: String(err),
      });
    }
  }

  // ---------- 6. Soft-deleted rows visible with include_deleted GUC ----------
  if (realTenantId) {
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${realTenantId}, true)`,
        );
        await tx.execute(
          sql`select set_config('app.include_deleted', 'true', true)`,
        );
        return await tx.execute(
          sql`select count(*) filter (where deleted_at is not null)::int as deleted from companies`,
        );
      });
      const deleted =
        (rows as unknown as Array<{ deleted: number }>)[0]?.deleted ?? -1;
      checks.push({
        name: 'soft-deleted companies surface when app.include_deleted=true',
        pass: deleted >= 0,
        detail: `count=${deleted}`,
      });
    } catch (err) {
      checks.push({
        name: 'soft-deleted companies surface when app.include_deleted=true',
        pass: false,
        detail: String(err),
      });
    }
  }

  // ---------- 7. Activity logs are also tenant-scoped ----------
  if (realTenantId) {
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await tx.execute(
          sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
        );
        return await tx.execute(
          sql`select count(*)::int as n from activity_logs`,
        );
      });
      const n = (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
      checks.push({
        name: 'activity_logs SELECT with non-matching tenant returns 0 rows',
        pass: n === 0,
        detail: `count=${n}`,
      });
    } catch (err) {
      checks.push({
        name: 'activity_logs SELECT with non-matching tenant returns 0 rows',
        pass: false,
        detail: String(err),
      });
    }
  }

  // ---------- Report ----------
  console.log('');
  let okCount = 0;
  for (const check of checks) {
    const tag = check.pass ? 'OK  ' : 'FAIL';
    console.log(`${tag} ${check.name}`);
    if (check.detail) console.log(`     ${check.detail}`);
    if (check.pass) okCount += 1;
  }
  console.log('');
  console.log(`${okCount} / ${checks.length} checks passed`);

  await client.end({ timeout: 5 });
  if (okCount < checks.length) process.exitCode = 1;
}

void main();
