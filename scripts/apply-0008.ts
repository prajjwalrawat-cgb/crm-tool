import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

async function main() {
  const { db, client } = await import('../src/db/index');
  const path = join(process.cwd(), 'drizzle', '0008_tasks_and_notes.sql');
  const raw = readFileSync(path, 'utf8');

  // The migration uses `--> statement-breakpoint` as the drizzle-kit
  // separator. Split on that, strip comments, run each statement.
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !s.startsWith('--') || s.split('\n').some((l) => !l.startsWith('--')));

  console.log(`applying ${statements.length} statements...`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    try {
      await db.execute(sql.raw(stmt));
      console.log(`  [${i + 1}/${statements.length}] ok`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('already exists') ||
        msg.includes('duplicate_object') ||
        msg.includes('duplicate object')
      ) {
        console.log(`  [${i + 1}/${statements.length}] already exists, skipping`);
      } else {
        console.error(`  [${i + 1}/${statements.length}] FAILED: ${msg}`);
        console.error(`  Statement: ${stmt.slice(0, 200)}`);
        throw err;
      }
    }
  }

  // Mark the migration as applied in drizzle's journal table so
  // subsequent `drizzle-kit migrate` runs don't try to apply it again.
  await db.execute(sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    SELECT 'manual-0008-tasks-and-notes', 1778500000000
    WHERE NOT EXISTS (
      SELECT 1 FROM drizzle.__drizzle_migrations
      WHERE hash = 'manual-0008-tasks-and-notes'
    )
  `);

  console.log('done.');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('apply fatal:', err);
  process.exit(1);
});
