/**
 * Read-only: is the keyset index usable, and why does the planner skip it?
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');

  const [{ id: tid }] = (await db.execute(
    sql`select t.id from tenants t join deals d on d.tenant_id=t.id
        where d.deleted_at is null group by t.id order by count(*) desc limit 1`,
  )) as unknown as Array<{ id: string }>;
  const [{ user_id: uid }] = (await db.execute(
    sql`select user_id from memberships where tenant_id=${tid}::uuid limit 1`,
  )) as unknown as Array<{ user_id: string }>;

  const [{ n: total }] = (await db.execute(
    sql`select count(*)::int as n from deals`,
  )) as unknown as Array<{ n: number }>;
  console.log(`\ndeals table: ${total} rows total\n`);

  const Q = sql`
    select d.id, d.name, d.stage from deals d
    where d.tenant_id = ${tid}::uuid and d.deleted_at is null
    order by d.created_at desc, d.id desc limit 51`;

  async function plan(label: string, pre?: ReturnType<typeof sql>) {
    const rows = (await db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_ctx(${tid}, ${uid}, false)`);
      if (pre) await tx.execute(pre);
      return await tx.execute(sql`explain (analyze, costs) ${Q}`);
    })) as unknown as Array<Record<string, string>>;
    const text = rows.map((r) => Object.values(r)[0]).join('\n');
    const scan = /(?:Index (?:Only )?Scan using (\S+)|Seq Scan)/.exec(text);
    const sorted = /Sort Method: (.+)/.exec(text);
    const exec = /Execution Time: ([\d.]+)/.exec(text);
    const est = /rows=(\d+)\D+width.*?\(actual .*?rows=(\d+)/.exec(text);
    console.log(
      `  ${label.padEnd(34)} scan=${(scan?.[1] ?? 'seq').padEnd(38)} ` +
        `sort=${(sorted?.[1] ?? 'none').padEnd(22)} ${exec?.[1] ?? '?'}ms` +
        (est ? `   est ${est[1]} vs actual ${est[2]} rows` : ''),
    );
  }

  console.log('planner choice for the deals list query');
  await plan('as the app runs it (with RLS)');
  await plan('with sorting disabled', sql`set local enable_sort = off`);

  // Same query with no RLS context — shows what the planner does when it
  // can actually estimate selectivity.
  const noRls = (await db.execute(
    sql`explain (analyze, costs) select d.id, d.name, d.stage from deals d
        where d.tenant_id = ${tid}::uuid and d.deleted_at is null
        order by d.created_at desc, d.id desc limit 51`,
  )) as unknown as Array<Record<string, string>>;
  const t = noRls.map((r) => Object.values(r)[0]).join('\n');
  console.log('\nsame query WITHOUT the RLS predicate (planner can estimate):');
  for (const line of t.split('\n').slice(0, 6)) console.log('   ' + line);

  // Is the column-side cast in the RLS policy what breaks estimation?
  // `tenant_id::text = current_setting(...)` casts the COLUMN, so Postgres
  // cannot use tenant_id's statistics and falls back to a rows=1 guess.
  // Same predicate with the cast moved to the constant side:
  console.log('\nwhy the estimate is wrong — cast placement in the RLS predicate:');
  for (const [label, pred] of [
    ['tenant_id::text = current_setting(...)  (current policy)', sql`d.tenant_id::text = current_setting('app.tenant_id', true)`],
    ['tenant_id = current_setting(...)::uuid  (cast on constant)', sql`d.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`],
  ] as const) {
    const rows = (await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tid}, true)`);
      return await tx.execute(sql`
        explain (analyze, costs)
        select d.id from deals d where ${pred} and d.deleted_at is null
        order by d.created_at desc, d.id desc limit 51`);
    })) as unknown as Array<Record<string, string>>;
    const text = rows.map((r) => Object.values(r)[0]).join('\n');
    const scan = /Index (?:Only )?Scan using (\S+)/.exec(text);
    const est = /rows=(\d+)[^)]*\)\s*\(actual[^)]*rows=(\d+)/.exec(text);
    console.log(
      `   ${label.padEnd(58)} est ${(est?.[1] ?? '?').padStart(4)} vs actual ${(est?.[2] ?? '?').padStart(4)}` +
        `   scan=${scan?.[1] ?? 'seq'}   sort=${/Sort Method/.test(text) ? 'YES' : 'no'}`,
    );
  }

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
