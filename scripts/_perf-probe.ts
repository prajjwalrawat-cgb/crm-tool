import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

function ms(a: bigint, b: bigint): number {
  return Number(b - a) / 1e6;
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const TID = '11111111-1111-1111-1111-111111111111';

async function main() {
  const { db, client } = await import('../src/db/index');
  await db.execute(sql`select 1`); // warm up

  // OLD per-query pattern: BEGIN + SET ROLE + 2x set_config + query + COMMIT
  const oldTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = process.hrtime.bigint();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      await tx.execute(sql`select set_config('app.tenant_id', ${TID}, true)`);
      await tx.execute(sql`select set_config('app.user_id', 'probe', true)`);
      await tx.execute(sql`select 1`);
    });
    oldTimes.push(ms(a, process.hrtime.bigint()));
  }

  // NEW per-query pattern: BEGIN + app_set_ctx() + query + COMMIT
  const newTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = process.hrtime.bigint();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_ctx(${TID}, 'probe', false)`);
      await tx.execute(sql`select 1`);
    });
    newTimes.push(ms(a, process.hrtime.bigint()));
  }

  // A query-heavy page = ~8 RLS reads. OLD = serialized (pool max:1).
  // NEW = concurrent (pool max:10) with the cheaper per-query setup.
  const N = 8;
  let a = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_ctx(${TID}, 'probe', false)`);
      await tx.execute(sql`select 1`);
    });
  }
  const seq = ms(a, process.hrtime.bigint());

  a = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: N }, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_ctx(${TID}, 'probe', false)`);
        await tx.execute(sql`select 1`);
      }),
    ),
  );
  const par = ms(a, process.hrtime.bigint());

  console.log(`per-query  OLD (6 round-trips) : ${avg(oldTimes).toFixed(0)}ms`);
  console.log(`per-query  NEW (app_set_ctx)   : ${avg(newTimes).toFixed(0)}ms`);
  console.log(`${N} RLS reads, sequential        : ${seq.toFixed(0)}ms`);
  console.log(`${N} RLS reads, parallel (pool)    : ${par.toFixed(0)}ms   ← what a page now pays`);

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
