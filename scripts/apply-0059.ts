import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Applies 0059_rls_uuid_predicate.sql idempotently.
 *
 * After applying, asserts that zero policies still carry the
 * `(tenant_id)::text` cast — the whole point of the migration is that the
 * predicate becomes index-eligible, and a partial rewrite would silently
 * leave some tables on Seq Scans.
 */
async function main() {
  const { db, client } = await import('../src/db/index');
  const path = join(process.cwd(), 'drizzle', '0059_rls_uuid_predicate.sql');
  const raw = readFileSync(path, 'utf8');
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter(
      (s) =>
        !s.startsWith('--') || s.split('\n').some((l) => !l.startsWith('--')),
    );

  const before = (await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') LIKE '%(tenant_id)::text%'
        OR coalesce(with_check, '') LIKE '%(tenant_id)::text%')
  `)) as unknown as Array<{ n: number }>;
  console.log(`policies on the text cast before: ${before[0]?.n ?? 0}`);

  console.log(`applying ${statements.length} statements...`);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    try {
      await db.execute(sql.raw(stmt));
      console.log(`  [${i + 1}/${statements.length}] ok`);
    } catch (err) {
      const cause = (err as { cause?: { message?: string } })?.cause;
      const msg = `${err instanceof Error ? err.message : String(err)} ${cause?.message ?? ''}`;
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`  [${i + 1}/${statements.length}] already exists, skipping`);
      } else {
        console.error(`  [${i + 1}/${statements.length}] FAILED: ${msg}`);
        throw err;
      }
    }
  }

  const after = (await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') LIKE '%(tenant_id)::text%'
        OR coalesce(with_check, '') LIKE '%(tenant_id)::text%')
  `)) as unknown as Array<{ n: number }>;
  const remaining = after[0]?.n ?? 0;
  console.log(`policies on the text cast after:  ${remaining}`);
  if (remaining > 0) {
    throw new Error(
      `0059 left ${remaining} policies on the text cast — those tables still Seq Scan under RLS.`,
    );
  }

  await db.execute(sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    SELECT 'manual-0059-rls-uuid-predicate', 1789173600000
    WHERE NOT EXISTS (
      SELECT 1 FROM drizzle.__drizzle_migrations
      WHERE hash = 'manual-0059-rls-uuid-predicate'
    )
  `);
  console.log('done.');
  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error('apply fatal:', err);
  process.exit(1);
});
