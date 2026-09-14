import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

const MARKER = 'manual-0067-offerings-workspace-flag';

/**
 * Applies 0067_offerings_workspace_flag.sql ONCE.
 *
 * Unlike the earlier apply scripts, this one checks its marker FIRST and
 * exits without executing anything if it has already run. The earlier
 * scripts can afford to replay on every deploy because their statements are
 * pure DDL (`IF NOT EXISTS`) — re-running them changes nothing. This file
 * also carries a DATA backfill that sets `offerings_enabled = true` for the
 * workspaces already using the feature, and the build chain runs every apply
 * script on every deploy. Replaying that UPDATE would silently switch
 * Offerings back ON for CGB on the next deploy after an admin had switched it
 * off — an admin setting that doesn't survive a deploy is not a setting.
 */
async function main() {
  const { db, client } = await import('../src/db/index');

  const already = (await db.execute(sql`
    SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${MARKER} LIMIT 1
  `)) as unknown as unknown[];
  if (already.length > 0) {
    console.log('0067 already applied — skipping (one-shot data backfill).');
    await client.end({ timeout: 5 });
    return;
  }

  const path = join(process.cwd(), 'drizzle', '0067_offerings_workspace_flag.sql');
  const raw = readFileSync(path, 'utf8');
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter(
      (s) =>
        !s.startsWith('--') || s.split('\n').some((l) => !l.startsWith('--')),
    );

  // Column add, backfill and marker commit together. If the backfill failed
  // after the column landed but before the marker was written, the next deploy
  // would retry it — fine. If the marker landed without the backfill, CGB
  // would be stranded OFF forever. One transaction rules out the second case.
  await db.transaction(async (tx) => {
    console.log(`applying ${statements.length} statements...`);
    for (let i = 0; i < statements.length; i++) {
      await tx.execute(sql.raw(statements[i]!));
      console.log(`  [${i + 1}/${statements.length}] ok`);
    }
    await tx.execute(sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${MARKER}, 1791752400000)
    `);
  });

  const enabled = (await db.execute(sql`
    SELECT t.name FROM workspace_settings ws
    JOIN tenants t ON t.id = ws.tenant_id
    WHERE ws.offerings_enabled
    ORDER BY t.name
  `)) as unknown as Array<{ name: string }>;
  console.log(
    `Offerings enabled for: ${enabled.map((r) => r.name).join(', ') || '(none)'}`,
  );
  console.log('done.');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('apply fatal:', err);
  process.exit(1);
});
