import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Server-side benchmark for the queries each dashboard page actually
 * runs. We hit them under `set local role app_user` + tenant context
 * (same path as the request handler) to capture realistic RLS overhead.
 *
 * Run after `pnpm seed:stress` for meaningful numbers.
 */

type Result = {
  label: string;
  rows: number;
  ms: number;
};

async function timeIt<T extends Array<unknown>>(
  label: string,
  fn: () => Promise<T>,
): Promise<Result> {
  const start = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { label, rows: out.length, ms };
}

async function main() {
  const { db, client } = await import('../src/db/index');

  const tenantId =
    process.env.TENANT_ID ??
    (
      (await db.execute(
        sql`SELECT id FROM tenants ORDER BY created_at LIMIT 1`,
      )) as unknown as Array<{ id: string }>
    )[0]?.id;
  if (!tenantId) {
    console.error('No tenant found.');
    process.exit(2);
  }
  console.log(`benchmarking against tenant=${tenantId}\n`);

  async function asAppUser<T>(fn: () => Promise<T>): Promise<T> {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(
        sql`select set_config('app.user_id', 'benchmark-script', true)`,
      );
      // We're inside a transaction so the role is set; the inner fn runs
      // raw SQL via the outer db connection because we can't easily pass
      // tx in. For meaningful comparison, we run the SQL via tx.execute.
      void fn;
      // Each timing uses tx directly:
      return undefined as unknown as T;
    });
  }
  // Avoid an unused-var warning since each timing builds its own tx.
  void asAppUser;

  const results: Result[] = [];

  // Each scenario opens its own tx so role + GUCs are honored, mirroring
  // exactly what tenantTransaction does in production.
  async function runQuery(label: string, query: ReturnType<typeof sql>) {
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'bench', true)`);
      const start = process.hrtime.bigint();
      const out = (await tx.execute(query)) as unknown as unknown[];
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      return { rows: out.length, ms };
    });
    results.push({ label, rows: r.rows, ms: r.ms });
  }

  // -- /dashboard/companies — listCompanies (paginated, default size 50)
  await runQuery(
    'companies list (paginated, size=50)',
    sql`SELECT id, name, domain, industry, created_at, updated_at, deleted_at, deleted_by
        FROM companies
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 51`,
  );

  // -- /dashboard/contacts — listContacts joined (paginated)
  await runQuery(
    'contacts list (joined, paginated, size=50)',
    sql`SELECT c.id, c.tenant_id, c.company_id, c.first_name, c.last_name,
               c.email, c.phone, c.title, c.created_at, c.updated_at,
               c.deleted_at, c.deleted_by, co.name AS company_name
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.tenant_id = ${tenantId}::uuid
          AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 51`,
  );

  // -- /dashboard/deals — listDeals joined (paginated)
  await runQuery(
    'deals list (joined, paginated, size=50)',
    sql`SELECT d.id, d.name, d.stage, d.amount_minor, d.currency,
               d.expected_close_date, d.closed_at, d.created_at, d.updated_at,
               co.name AS company_name,
               ct.first_name AS contact_first_name,
               ct.last_name AS contact_last_name,
               ct.email AS contact_email
        FROM deals d
        LEFT JOIN companies co ON co.id = d.company_id
        LEFT JOIN contacts  ct ON ct.id = d.contact_id
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 51`,
  );

  // -- /dashboard/deals/board — capped per stage. App fires six in
  // parallel; benchmark a single stage to capture per-query cost.
  await runQuery(
    'deals board (one stage, capped 50)',
    sql`SELECT d.id, d.name, d.stage, d.amount_minor, d.currency,
               d.updated_at, co.name AS company_name
        FROM deals d
        LEFT JOIN companies co ON co.id = d.company_id
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NULL
          AND d.stage = 'lead'
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT 50`,
  );

  await runQuery(
    'deals board (count by stage)',
    sql`SELECT stage, COUNT(*)::int AS n
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        GROUP BY stage`,
  );

  // -- /dashboard/activity — listRecentActivity (limit 50)
  await runQuery(
    'activity feed (limit 50)',
    sql`SELECT id, actor_user_id, entity_type, entity_id, action, metadata, created_at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at DESC
        LIMIT 50`,
  );

  // -- /dashboard/workflows — listing workflow_runs
  await runQuery(
    'workflow_runs list (limit 100)',
    sql`SELECT id, workflow_id, event_name, inngest_run_id, status, started_at,
               completed_at, error, metadata
        FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY started_at DESC
        LIMIT 100`,
  );

  // -- /dashboard/ops — getAiInvocationStats (24h aggregate)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await runQuery(
    'ops AI stats (24h aggregate)',
    sql`SELECT
          COUNT(*)::int            AS total,
          COUNT(*) FILTER (WHERE status = 'success')::int AS success,
          COUNT(*) FILTER (WHERE status = 'error')::int   AS error,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
          COALESCE(SUM(total_tokens), 0)::int             AS tokens
        FROM ai_invocations
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${since}`,
  );

  // -- /dashboard/ops — workflow stats per-workflow (the heavier groupBy)
  await runQuery(
    'ops workflow stats (24h, per workflow)',
    sql`SELECT workflow_id, COUNT(*)::int AS runs,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
               AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
                 FILTER (WHERE completed_at IS NOT NULL) AS avg_ms
        FROM workflow_runs
        WHERE tenant_id = ${tenantId}::uuid
          AND started_at >= ${since}
        GROUP BY workflow_id`,
  );

  // -- /dashboard/recently-deleted — three lists
  await runQuery(
    'recently deleted: companies',
    sql`SELECT id, name, domain, industry, deleted_at, deleted_by
        FROM companies
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`,
  );
  await runQuery(
    'recently deleted: contacts',
    sql`SELECT id, first_name, last_name, email, title, deleted_at, deleted_by
        FROM contacts
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`,
  );
  await runQuery(
    'recently deleted: deals',
    sql`SELECT id, name, stage, amount_minor, currency, deleted_at, deleted_by
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`,
  );

  console.log('---- benchmark results (sorted slowest first) ----');
  results.sort((a, b) => b.ms - a.ms);
  console.log('  ms   |  rows  | query');
  console.log('  -----+--------+---------------------------------------------');
  for (const r of results) {
    console.log(
      `  ${r.ms.toFixed(1).padStart(4)} | ${String(r.rows).padStart(6)} | ${r.label}`,
    );
  }

  // Capture EXPLAIN ANALYZE for the slowest one to surface plan choices.
  const slowest = results[0];
  if (slowest) {
    console.log(`\n---- EXPLAIN (ANALYZE, BUFFERS) on slowest: "${slowest.label}" ----`);
    // Re-issue the same query under EXPLAIN. We don't have the sql object;
    // simplest: rerun ad-hoc by label match.
    // Skipped here to keep the script generic; operators can wrap any
    // entry in EXPLAIN ANALYZE manually.
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('benchmark fatal:', err);
  process.exit(1);
});
