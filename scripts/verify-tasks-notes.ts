import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');
  const rows = (await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('tasks', 'notes')
    ORDER BY table_name
  `)) as unknown as Array<{ table_name: string }>;
  console.log('tables:', rows.map((r) => r.table_name).join(', ') || '(none)');

  const policies = (await db.execute(sql`
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('tasks', 'notes')
    ORDER BY tablename, policyname
  `)) as unknown as Array<{ tablename: string; policyname: string }>;
  for (const p of policies) {
    console.log(`policy: ${p.tablename}.${p.policyname}`);
  }

  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
