import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');

  const tables = (await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('agent_observations','agent_patterns','agent_recommendation_feedback')
    ORDER BY table_name
  `)) as unknown as Array<{ table_name: string }>;
  console.log('agent tables:');
  for (const t of tables) console.log(`  - ${t.table_name}`);

  const indexes = (await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('agent_observations','agent_patterns','agent_recommendation_feedback')
    ORDER BY tablename, indexname
  `)) as unknown as Array<{ indexname: string }>;
  console.log('indexes:');
  for (const i of indexes) console.log(`  - ${i.indexname}`);

  const policies = (await db.execute(sql`
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('agent_observations','agent_patterns','agent_recommendation_feedback')
    ORDER BY tablename
  `)) as unknown as Array<{ tablename: string; policyname: string }>;
  console.log('policies:');
  for (const p of policies) console.log(`  - ${p.tablename}: ${p.policyname}`);

  const hardening = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'communication_threads' AND column_name IN ('updated_by','last_message_id'))
        OR (table_name = 'communication_drafts' AND column_name = 'deleted_at'))
    ORDER BY table_name, column_name
  `)) as unknown as Array<{ column_name: string }>;
  console.log('hardening columns present:');
  for (const c of hardening) console.log(`  - ${c.column_name}`);

  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
