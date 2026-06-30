import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/** Applies 0037_link_deal_company_contact.sql idempotently. */
async function main() {
  const { db, client } = await import('../src/db/index');
  const path = join(process.cwd(), 'drizzle', '0037_link_deal_company_contact.sql');
  const raw = readFileSync(path, 'utf8');
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter(
      (s) =>
        !s.startsWith('--') || s.split('\n').some((l) => !l.startsWith('--')),
    );
  console.log(`applying ${statements.length} statements...`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    const res = await db.execute(sql.raw(stmt));
    console.log(`  [${i + 1}/${statements.length}] ok (rows: ${(res as { rowCount?: number }).rowCount ?? '?'})`);
  }
  await db.execute(sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    SELECT 'manual-0037-link-deal-company-contact', 1788000006000
    WHERE NOT EXISTS (
      SELECT 1 FROM drizzle.__drizzle_migrations
      WHERE hash = 'manual-0037-link-deal-company-contact'
    )
  `);
  console.log('done.');
  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error('apply fatal:', err);
  process.exit(1);
});
