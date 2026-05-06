import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

type CheckRow = {
  version: string;
  database: string;
  now: string;
};

type TableRow = { table_name: string };

async function main() {
  const { db, client } = await import('../src/db/index');

  const startedAt = Date.now();

  try {
    const meta = (await db.execute(
      sql`select version() as version, current_database() as database, now() as now`,
    )) as unknown as CheckRow[];

    const tables = (await db.execute(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
          order by table_name`,
    )) as unknown as TableRow[];

    const elapsedMs = Date.now() - startedAt;
    const row = meta[0];

    console.log(`OK  connected in ${elapsedMs}ms`);
    console.log(`    database: ${row?.database ?? '?'}`);
    console.log(`    server:   ${row?.version ?? '?'}`);
    console.log(`    time:     ${row?.now ?? '?'}`);
    console.log(`    tables:   ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);
  } catch (err) {
    console.error('FAIL connection error:');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
