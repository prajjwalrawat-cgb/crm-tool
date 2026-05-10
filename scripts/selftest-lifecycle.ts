import { config } from 'dotenv';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * End-to-end self-test for the entity lifecycle. Hits the same DB paths
 * the UI hits — but bypasses the `server-only`-guarded `db-context`
 * module by hand-rolling the role drop + GUC sets per transaction (same
 * pattern as scripts/verify-rls.ts).
 *
 * Verifies:
 *   - create / read / update under tenant context
 *   - soft-delete works under app_user role with includeDeleted=true
 *     (the regression that motivated the fix in companies/contacts/
 *     deals soft-delete actions)
 *   - the SELECT policy hides soft-deleted rows by default
 *   - includeDeleted=true reveals them again
 *   - activity log rows are written
 *   - restore brings the row back and clears deleted_at
 *   - tenant isolation: a second tenant's context cannot SELECT the row
 *
 * Run:
 *   pnpm tsx scripts/selftest-lifecycle.ts
 */

type TenantRow = { id: string };

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { companies, activityLogs } = await import('../src/db/schema');

  /* helper that mirrors what tenantTransaction does in app code */
  async function txAs<T>(
    opts: { tenantId: string; userId: string; includeDeleted?: boolean },
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${opts.tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${opts.userId}, true)`);
      if (opts.includeDeleted) {
        await tx.execute(sql`select set_config('app.include_deleted', 'true', true)`);
      }
      return await fn(tx);
    });
  }

  // Pick two distinct tenants. We'll use the first as the "active" one
  // and the second to verify isolation.
  const allTenants = (await db.execute(
    sql`SELECT id FROM tenants ORDER BY created_at LIMIT 2`,
  )) as unknown as TenantRow[];
  if (allTenants.length === 0) {
    console.error('No tenants found — sign in via the app to provision one first.');
    process.exit(2);
  }
  const tenantA = allTenants[0]!.id;
  const tenantB = allTenants[1]?.id ?? null;
  console.log(`tenantA=${tenantA}  tenantB=${tenantB ?? '(none — isolation test will be skipped)'}`);

  const SYSTEM_USER = 'selftest-script';

  /* -------- COMPANY lifecycle -------- */

  let companyId = '';

  // CREATE
  const created = await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    const [row] = await tx
      .insert(companies)
      .values({ tenantId: tenantA, name: 'Selftest Co.', domain: 'selftest.example' })
      .returning();
    return row;
  });
  check('company create', !!created && created.name === 'Selftest Co.');
  companyId = created!.id;

  // READ — visible
  await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    const visible = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, tenantA),
          eq(companies.id, companyId),
          isNull(companies.deletedAt),
        ),
      );
    check('company select after create', visible.length === 1);
  });

  // UPDATE
  const updated = await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    const [row] = await tx
      .update(companies)
      .set({ industry: 'Software' })
      .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantA)))
      .returning();
    return row;
  });
  check('company update', updated?.industry === 'Software');

  // ACTIVITY log — write directly using the activity schema (mirrors recordActivity)
  await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    await tx.insert(activityLogs).values({
      tenantId: tenantA,
      actorUserId: SYSTEM_USER,
      entityType: 'company',
      entityId: companyId,
      action: 'updated',
      metadata: { name: 'Selftest Co.' },
    });
  });

  // SOFT-DELETE — must include includeDeleted=true (the bug we fixed)
  const deleted = await txAs(
    { tenantId: tenantA, userId: SYSTEM_USER, includeDeleted: true },
    async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({ deletedAt: new Date(), deletedBy: SYSTEM_USER })
        .where(
          and(
            eq(companies.id, companyId),
            eq(companies.tenantId, tenantA),
            isNull(companies.deletedAt),
          ),
        )
        .returning();
      return row;
    },
  );
  check(
    'company soft-delete with includeDeleted (RLS regression fix)',
    !!deleted && deleted.deletedAt !== null,
  );

  // SELECT under default — row hidden.
  await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    const visible = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantA), eq(companies.id, companyId)));
    check(
      'company hidden from SELECT under default (deleted_at filter)',
      visible.length === 0,
    );
  });

  // SELECT with includeDeleted — row revealed.
  await txAs(
    { tenantId: tenantA, userId: SYSTEM_USER, includeDeleted: true },
    async (tx) => {
      const visible = await tx
        .select({ id: companies.id, deletedAt: companies.deletedAt })
        .from(companies)
        .where(and(eq(companies.tenantId, tenantA), eq(companies.id, companyId)));
      check(
        'company visible under includeDeleted',
        visible.length === 1 && visible[0]!.deletedAt !== null,
      );
    },
  );

  // RESTORE
  const restored = await txAs(
    { tenantId: tenantA, userId: SYSTEM_USER, includeDeleted: true },
    async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({ deletedAt: null, deletedBy: null })
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantA)))
        .returning();
      return row;
    },
  );
  check('company restore', restored?.deletedAt === null);

  /* -------- TENANT ISOLATION -------- */

  if (tenantB) {
    await txAs({ tenantId: tenantB, userId: SYSTEM_USER }, async (tx) => {
      const stranger = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId));
      check(
        'tenant isolation — tenantB cannot SELECT tenantA company',
        stranger.length === 0,
      );
    });
  }

  /* -------- ACTIVITY LOG check -------- */

  await txAs({ tenantId: tenantA, userId: SYSTEM_USER }, async (tx) => {
    const logs = await tx
      .select({ action: activityLogs.action, entityId: activityLogs.entityId })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantA),
          eq(activityLogs.entityId, companyId),
        ),
      )
      .orderBy(desc(activityLogs.createdAt))
      .limit(5);
    check(
      'activity log written for the entity',
      logs.length > 0 && logs.some((l) => l.action === 'updated'),
    );
  });

  /* -------- HARD-CLEANUP so we don't leave selftest rows -------- */

  // Delete via the postgres connection role (tenants/postgres has DELETE
  // on these tables; this bypasses the SELECT-deleted_at filter).
  await db
    .delete(activityLogs)
    .where(
      and(eq(activityLogs.tenantId, tenantA), eq(activityLogs.entityId, companyId)),
    );
  await db.delete(companies).where(eq(companies.id, companyId));

  /* -------- Print results table -------- */

  console.log('\n----- selftest-lifecycle results -----');
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n  ${passed}/${results.length} passed.`);

  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal error:', err);
  process.exit(1);
});
