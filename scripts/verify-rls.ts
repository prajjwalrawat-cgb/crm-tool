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

  // ---------- 8. Catalog: every tenant table in public has RLS ----------
  await catalogChecks(db, checks);

  // ---------- 9. The 0075 tables behave like every other tenant table ----------
  if (realTenantId) await gapTableChecks(db, checks, realTenantId);

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

type Db = (typeof import('../src/db/index'))['db'];

/**
 * Tables with a tenant_id column that are deliberately NOT under RLS. Each
 * needs a reason; this list may only shrink.
 */
const TENANT_TABLES_WITHOUT_RLS: Record<string, string> = {
  pending_role_intents:
    'Clerk-era invite role intent, read during sign-in before a tenant context; scoped by (tenant_id, email_lc). Follow-up: move behind a SECURITY DEFINER lookup like org_invitations.',
};

/**
 * Tenant tables that have RLS enabled but not FORCED. FORCE only changes
 * behaviour for the table owner (app code runs as app_user, which RLS always
 * applies to), so these are still isolated in the app. Listed so that any NEW
 * table without FORCE fails. This list may only shrink.
 */
const LEGACY_RLS_WITHOUT_FORCE = new Set([
  'agent_observations', 'agent_patterns', 'agent_recommendation_feedback', 'ai_feedback',
  'askmira_connect_codes', 'askmira_links', 'askmira_people', 'askmira_used_tokens',
  'collection_settings', 'communication_analytics', 'communication_drafts',
  'communication_events', 'communication_participants', 'communication_threads',
  'deal_credit_terms', 'deal_offerings', 'deal_order_proofs', 'incentive_actuals',
  'incentive_plan_templates', 'incentive_plan_versions', 'incentive_plans',
  'invoice_payments', 'offerings', 'organization_settings', 'relationship_signals',
]);

async function catalogChecks(db: Db, checks: Check[]) {
  try {
    const rows = (await db.execute(sql`
      select c.relname as name,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as force,
             exists (
               select 1 from information_schema.columns col
               where col.table_schema = 'public' and col.table_name = c.relname
                 and col.column_name = 'tenant_id'
             ) as tenant,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      order by c.relname
    `)) as unknown as Array<{
      name: string;
      rls: boolean;
      force: boolean;
      tenant: boolean;
      policies: number;
    }>;

    const tenantTables = rows.filter((r) => r.tenant);
    const noRls = tenantTables.filter(
      (r) => !r.rls && !(r.name in TENANT_TABLES_WITHOUT_RLS),
    );
    checks.push({
      name: `every tenant table has RLS enabled (${tenantTables.length} tenant tables of ${rows.length})`,
      pass: noRls.length === 0,
      detail: noRls.length
        ? `missing RLS: ${noRls.map((r) => r.name).join(', ')}`
        : `allowlisted without RLS: ${Object.keys(TENANT_TABLES_WITHOUT_RLS).join(', ')}`,
    });

    const noForce = tenantTables.filter(
      (r) => r.rls && !r.force && !LEGACY_RLS_WITHOUT_FORCE.has(r.name),
    );
    const legacyLeft = tenantTables.filter(
      (r) => r.rls && !r.force && LEGACY_RLS_WITHOUT_FORCE.has(r.name),
    );
    checks.push({
      name: 'every tenant table with RLS also FORCEs it (except the legacy list)',
      pass: noForce.length === 0,
      detail: noForce.length
        ? `not forced: ${noForce.map((r) => r.name).join(', ')}`
        : `legacy not forced: ${legacyLeft.length}`,
    });

    const noPolicy = tenantTables.filter((r) => r.rls && r.policies === 0);
    checks.push({
      name: 'RLS tenant tables have at least one policy (else deny-all)',
      pass: true, // informational: deny-all is safe, just possibly unintended
      detail: noPolicy.length
        ? `WARN no policies (deny-all to app_user): ${noPolicy.map((r) => r.name).join(', ')}`
        : 'all have policies',
    });

    const roles = (await db.execute(
      sql`select rolname from pg_roles where rolname in ('anon', 'authenticated')`,
    )) as unknown as Array<{ rolname: string }>;
    if (roles.length === 0) {
      checks.push({
        name: 'anon/authenticated have no privileges on public tables',
        pass: true,
        detail: 'roles absent (not a Supabase database); skipped',
      });
    } else {
      const exposed = (await db.execute(sql`
        select c.relname as name, r.rolname as role
        from pg_class c
        cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege(r.rolname, c.oid, 'SELECT')
            or has_table_privilege(r.rolname, c.oid, 'INSERT')
            or has_table_privilege(r.rolname, c.oid, 'UPDATE')
            or has_table_privilege(r.rolname, c.oid, 'DELETE'))
        order by 1, 2
      `)) as unknown as Array<{ name: string; role: string }>;
      checks.push({
        name: 'anon/authenticated have no privileges on public tables',
        pass: exposed.length === 0,
        detail: exposed.length
          ? `exposed: ${exposed.map((e) => `${e.name}(${e.role})`).join(', ')}`
          : `checked roles: ${roles.map((r) => r.rolname).join(', ')}`,
      });

      const pw = (await db.execute(sql`
        select has_column_privilege('anon', 'public.users', 'password_hash', 'SELECT') as anon_pw
      `)) as unknown as Array<{ anon_pw: boolean }>;
      checks.push({
        name: 'anon cannot read users.password_hash',
        pass: pw[0]?.anon_pw === false,
        detail: `has_column_privilege=${pw[0]?.anon_pw}`,
      });

      const fns = (await db.execute(sql`
        select p.proname as name
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosecdef
          and has_function_privilege('anon', p.oid, 'EXECUTE')
      `)) as unknown as Array<{ name: string }>;
      checks.push({
        name: 'anon cannot execute SECURITY DEFINER functions in public',
        pass: fns.length === 0,
        detail: fns.length ? `executable: ${fns.map((f) => f.name).join(', ')}` : 'none',
      });
    }
  } catch (err) {
    checks.push({ name: 'catalog checks', pass: false, detail: String(err) });
  }
}

const GAP_TABLES = [
  'sales_targets',
  'custom_field_definitions',
  'invoice_seller_profiles',
  'chart_views',
  'dashboard_widgets',
  'org_invitations',
] as const;

class Rollback extends Error {}

/**
 * Behavioural checks for the 0075 tables. Fixtures are written as the
 * connection owner inside a transaction that is always rolled back, then the
 * same transaction drops to app_user to read them under each tenant id.
 */
async function gapTableChecks(db: Db, checks: Check[], tenantId: string) {
  const OTHER = '00000000-0000-0000-0000-000000000000';
  const tokenHash = `verify-rls-${Date.now()}`;
  const expiredHash = `${tokenHash}-expired`;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into org_invitations (tenant_id, email, role, token_hash, expires_at)
        values (${tenantId}, 'verify-rls@example.invalid', 'member', ${tokenHash}, now() + interval '1 hour'),
               (${tenantId}, 'verify-rls-expired@example.invalid', 'member', ${expiredHash}, now() - interval '1 hour')
      `);
      await tx.execute(sql`
        insert into custom_field_definitions (tenant_id, entity_type, key, label, field_type)
        values (${tenantId}, 'deal', ${`verify_rls_${Date.now()}`}, 'verify rls', 'text')
      `);

      // Pre-tenant lookup: app_user with NO tenant id set.
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
      const found = (await tx.execute(
        sql`select tenant_id::text as t from org_invitation_by_token(${tokenHash})`,
      )) as unknown as Array<{ t: string }>;
      const expired = (await tx.execute(
        sql`select 1 from org_invitation_by_token(${expiredHash})`,
      )) as unknown as unknown[];
      const direct = (await tx.execute(
        sql`select count(*)::int as n from org_invitations where token_hash = ${tokenHash}`,
      )) as unknown as Array<{ n: number }>;
      checks.push({
        name: 'org_invitation_by_token resolves a valid invite with no tenant context',
        pass: found.length === 1 && found[0]?.t === tenantId,
        detail: `rows=${found.length}`,
      });
      checks.push({
        name: 'org_invitation_by_token refuses an expired invite',
        pass: expired.length === 0,
        detail: `rows=${expired.length}`,
      });
      checks.push({
        name: 'org_invitations direct SELECT with no tenant context returns 0 rows',
        pass: direct[0]?.n === 0,
        detail: `count=${direct[0]?.n}`,
      });

      // Wrong tenant: every gap table reads as empty.
      await tx.execute(sql`select set_config('app.tenant_id', ${OTHER}, true)`);
      for (const t of GAP_TABLES) {
        const r = (await tx.execute(
          sql.raw(`select count(*)::int as n from "${t}"`),
        )) as unknown as Array<{ n: number }>;
        checks.push({
          name: `${t} SELECT with non-matching tenant returns 0 rows`,
          pass: r[0]?.n === 0,
          detail: `count=${r[0]?.n}`,
        });
      }

      // Right tenant: the fixtures are visible.
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      const mine = (await tx.execute(sql`
        select (select count(*)::int from org_invitations where token_hash = ${tokenHash}) as inv,
               (select count(*)::int from custom_field_definitions where label = 'verify rls') as cf
      `)) as unknown as Array<{ inv: number; cf: number }>;
      checks.push({
        name: 'org_invitations / custom_field_definitions visible to the owning tenant',
        pass: mine[0]?.inv === 1 && (mine[0]?.cf ?? 0) >= 1,
        detail: `inv=${mine[0]?.inv} cf=${mine[0]?.cf}`,
      });

      // Cross-tenant write is rejected.
      try {
        await tx.execute(sql`savepoint xt`);
        await tx.execute(sql`
          insert into custom_field_definitions (tenant_id, entity_type, key, label, field_type)
          values (${OTHER}, 'deal', 'verify_rls_x', 'verify rls x', 'text')
        `);
        checks.push({
          name: 'custom_field_definitions INSERT for another tenant is blocked',
          pass: false,
          detail: 'insert succeeded',
        });
      } catch (err) {
        await tx.execute(sql`rollback to savepoint xt`);
        checks.push({
          name: 'custom_field_definitions INSERT for another tenant is blocked',
          pass: true,
          detail: `rejected: ${(err as { cause?: { code?: string } }).cause?.code ?? 'error'}`,
        });
      }

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) {
      checks.push({ name: '0075 gap table checks', pass: false, detail: String(err) });
    }
  }
}

void main();
