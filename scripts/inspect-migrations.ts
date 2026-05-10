import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');

  console.log('---- drizzle.__drizzle_migrations ----');
  try {
    const rows = (await db.execute(
      sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    )) as unknown as Array<{ id: number; hash: string; created_at: string | number }>;
    console.table(rows);
  } catch (err) {
    console.log('drizzle journal table query failed:', err);
  }

  console.log('\n---- alphabetical list of all public tables ----');
  const tables = (await db.execute(
    sql`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
  )) as unknown as Array<{ table_name: string }>;
  console.table(tables);

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
