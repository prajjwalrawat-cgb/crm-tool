/**
 * Read-only performance audit probe.
 *
 * Measures, against whatever DATABASE_URL is configured:
 *   1. raw network round-trip cost to Postgres
 *   2. the `tenantTransaction` wrapper's own overhead (BEGIN + app_set_ctx
 *      + COMMIT on top of the actual statement)
 *   3. every query the /dashboard/deals render issues, individually
 *   4. the same set run the way the page runs it (Promise.all)
 *   5. the serialized payload size each query contributes to the RSC stream
 *   6. what happens when N page renders run concurrently — i.e. the
 *      production `<Link>` prefetch storm against a pool of `max`
 *
 * Nothing here writes. Safe to run against production.
 *
 *   npx tsx --require ./scripts/_shim-server-only.cjs scripts/_perf-audit.ts
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const kb = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8') / 1024;

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const a = process.hrtime.bigint();
  const out = await fn();
  return [out, ms(a, process.hrtime.bigint())];
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const { runWithTenantContext } = await import('../src/lib/db-context');

  const host = new URL(process.env.DATABASE_URL!).host;
  console.log(`\n=== target: ${host} ===\n`);

  await db.execute(sql`select 1`); // warm the pool / TLS handshake

  /* 1. raw round-trip -------------------------------------------------- */
  const rtt: number[] = [];
  for (let i = 0; i < 15; i++) {
    const [, t] = await time(() => db.execute(sql`select 1`));
    rtt.push(t);
  }
  console.log(`raw RTT (select 1)          p50 ${p50(rtt).toFixed(1)}ms  avg ${avg(rtt).toFixed(1)}ms`);

  /* 2. tenantTransaction overhead -------------------------------------- */
  const tenantId =
    process.env.TENANT_ID ??
    (
      (await db.execute(
        sql`select t.id from tenants t
            join deals d on d.tenant_id = t.id and d.deleted_at is null
            group by t.id order by count(*) desc limit 1`,
      )) as unknown as Array<{ id: string }>
    )[0]?.id;
  if (!tenantId) {
    console.error('no tenant with deals found');
    process.exit(2);
  }
  const [{ user_id: userId } = { user_id: 'probe' }] = (await db.execute(
    sql`select user_id from memberships where tenant_id = ${tenantId}::uuid limit 1`,
  )) as unknown as Array<{ user_id: string }>;

  const [{ n: dealCount }] = (await db.execute(
    sql`select count(*)::int as n from deals where tenant_id = ${tenantId}::uuid and deleted_at is null`,
  )) as unknown as Array<{ n: number }>;
  console.log(`tenant ${tenantId}  (${dealCount} live deals, actor ${userId})\n`);

  const wrapped: number[] = [];
  for (let i = 0; i < 10; i++) {
    const [, t] = await time(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_ctx(${tenantId}, ${userId}, false)`);
        await tx.execute(sql`select 1`);
      }),
    );
    wrapped.push(t);
  }
  console.log(
    `tenantTransaction(select 1)  p50 ${p50(wrapped).toFixed(1)}ms` +
      `   → wrapper overhead ≈ ${(p50(wrapped) - p50(rtt)).toFixed(1)}ms/query\n`,
  );

  /* 3 + 4 + 5. the deals page's actual query set ------------------------ */
  const { listDeals, listDealCompanyOptions } = await import('../src/lib/deals/queries');
  const { listCompanyOptionsScoped } = await import('../src/lib/companies/queries');
  const { listContactPickerOptions } = await import('../src/lib/contacts/queries');
  const { listCustomFieldDefs } = await import('../src/lib/custom-fields/queries');
  const { listTeammates } = await import('../src/lib/deals/../teammates/queries');
  const { getOrgSettings } = await import('../src/lib/org-settings/queries');

  const [{ name: tenantName }] = (await db.execute(
    sql`select name from tenants where id = ${tenantId}::uuid`,
  )) as unknown as Array<{ name: string }>;

  const units: Array<[string, () => Promise<unknown>]> = [
    ['listDeals (size 50)', () => listDeals(tenantId, { size: 50 })],
    ['listDealCompanyOptions', () => listDealCompanyOptions(tenantId)],
    ['listCompanyOptionsScoped', () => listCompanyOptionsScoped(tenantId)],
    ['listContactPickerOptions', () => listContactPickerOptions(tenantId)],
    ['listTeammates', () => listTeammates(tenantId, tenantName)],
    ['listCustomFieldDefs(deal)', () => listCustomFieldDefs(tenantId, 'deal')],
    ['getOrgSettings', () => getOrgSettings(tenantId)],
  ];

  await runWithTenantContext({ tenantId, userId }, async () => {
    console.log('--- per-query (sequential, warm pool) ---');
    let totalKb = 0;
    for (const [label, fn] of units) {
      const samples: number[] = [];
      let last: unknown;
      for (let i = 0; i < 5; i++) {
        const [out, t] = await time(fn);
        last = out;
        samples.push(t);
      }
      const rows = Array.isArray(last)
        ? last.length
        : Array.isArray((last as { items?: unknown[] })?.items)
          ? (last as { items: unknown[] }).items.length
          : 1;
      const size = kb(last);
      totalKb += size;
      console.log(
        `  ${label.padEnd(28)} p50 ${p50(samples).toFixed(0).padStart(5)}ms   ` +
          `${String(rows).padStart(5)} rows   ${size.toFixed(1).padStart(7)} KB`,
      );
    }
    console.log(`  ${'TOTAL serialized'.padEnd(28)} ${' '.repeat(24)}${totalKb.toFixed(1)} KB\n`);

    console.log('--- whole page (Promise.all, as the page runs it) ---');
    const pageRuns: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [, t] = await time(() => Promise.all(units.map(([, fn]) => fn())));
      pageRuns.push(t);
    }
    console.log(`  deals page query set   p50 ${p50(pageRuns).toFixed(0)}ms\n`);

    /* 6. prefetch storm ------------------------------------------------- */
    console.log('--- concurrency: N simultaneous page renders (prefetch storm) ---');
    for (const n of [1, 4, 8, 12]) {
      const [, t] = await time(() =>
        Promise.all(
          Array.from({ length: n }, () => Promise.all(units.map(([, fn]) => fn()))),
        ),
      );
      console.log(
        `  ${String(n).padStart(2)} concurrent renders  ${t.toFixed(0).padStart(6)}ms` +
          `   (${(t / n).toFixed(0)}ms each, ${n * units.length} transactions)`,
      );
    }
  });

  /* EXPLAIN ANALYZE the list query ------------------------------------- */
  console.log('\n--- EXPLAIN ANALYZE: deals list ---');
  const plan = (await db.transaction(async (tx) => {
    await tx.execute(sql`select app_set_ctx(${tenantId}, ${userId}, false)`);
    return await tx.execute(sql`
      explain (analyze, buffers, format text)
      select d.*, coalesce(d.company_name, c.name), ct.first_name, ct.last_name,
             coalesce(d.contact_email, ct.email)
      from deals d
      left join companies c on d.company_id = c.id
      left join contacts ct on d.contact_id = ct.id
      where d.tenant_id = ${tenantId}::uuid and d.deleted_at is null
      order by d.created_at desc, d.id desc
      limit 51
    `);
  })) as unknown as Array<Record<string, string>>;
  for (const row of plan) console.log('   ' + Object.values(row)[0]);

  /* index inventory ----------------------------------------------------- */
  console.log('\n--- indexes on deals ---');
  const idx = (await db.execute(
    sql`select indexname, indexdef from pg_indexes where tablename = 'deals' order by indexname`,
  )) as unknown as Array<{ indexname: string; indexdef: string }>;
  for (const i of idx) console.log(`   ${i.indexdef.replace(/^CREATE (UNIQUE )?INDEX /, '')}`);

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
