import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');

  const tableExists = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ai_feedback'
    ) AS exists
  `)) as unknown as Array<{ exists: boolean }>;
  console.log(`table ai_feedback exists: ${tableExists[0]?.exists}`);

  const indexes = (await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'ai_feedback'
    ORDER BY indexname
  `)) as unknown as Array<{ indexname: string }>;
  console.log('indexes:');
  for (const i of indexes) console.log(`  - ${i.indexname}`);

  const policies = (await db.execute(sql`
    SELECT policyname, cmd, roles FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_feedback'
  `)) as unknown as Array<{
    policyname: string;
    cmd: string;
    roles: string[];
  }>;
  console.log('policies:');
  for (const p of policies)
    console.log(`  - ${p.policyname} (${p.cmd}) for ${p.roles.join(',')}`);

  const rlsEnabled = (await db.execute(sql`
    SELECT relrowsecurity AS enabled FROM pg_class
    WHERE relname = 'ai_feedback'
  `)) as unknown as Array<{ enabled: boolean }>;
  console.log(`RLS enabled: ${rlsEnabled[0]?.enabled}`);

  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
