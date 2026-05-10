import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

config({ path: '.env.local' });
config();

/**
 * Targeted migration runner for the case where Drizzle's built-in
 * `drizzle-kit migrate` silently skips files whose `when` timestamp in
 * `_journal.json` is older than the latest already-applied migration's
 * `created_at`. Drizzle's logic is:
 *
 *     `if last.created_at < migration.folderMillis: apply; else skip;`
 *
 * (see drizzle-orm/pg-core/dialect.js → migrate). Our journal had 0006
 * and 0007 with `when` values *earlier* than 0005, so they were never
 * applied — the call returned "migrations applied successfully" while
 * doing nothing.
 *
 * This script:
 *   1) reads each pending migration file
 *   2) verifies its target tables don't already exist (idempotency belt)
 *   3) executes the SQL inside a single transaction
 *   4) inserts the SHA-256(file) hash into `drizzle.__drizzle_migrations`
 *      with `created_at` set to the journal's `when`
 *   5) on success, rewrites `_journal.json` so `when` values are
 *      strictly increasing with `idx` — preventing the same silent-skip
 *      bug from biting the next developer.
 */

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

const DRIZZLE_DIR = join(process.cwd(), 'drizzle');
const JOURNAL_PATH = join(DRIZZLE_DIR, 'meta', '_journal.json');

function loadJournal(): Journal {
  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as Journal;
}

function fileHash(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const journal = loadJournal();
  const { db, client } = await import('../src/db/index');

  const dbHashes = new Set<string>(
    (
      (await db.execute(
        sql`SELECT hash FROM drizzle.__drizzle_migrations`,
      )) as unknown as Array<{ hash: string }>
    ).map((r) => r.hash),
  );

  const pending: Array<{ entry: JournalEntry; hash: string; sqlText: string }> = [];
  for (const entry of journal.entries) {
    const path = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    const sqlText = readFileSync(path, 'utf8');
    const hash = createHash('sha256').update(sqlText).digest('hex');
    if (dbHashes.has(hash)) continue;
    pending.push({ entry, hash, sqlText });
  }

  if (pending.length === 0) {
    console.log('All migrations already in __drizzle_migrations. Nothing to do.');
    await client.end({ timeout: 5 });
    return;
  }
  console.log(
    `Pending: ${pending.map((p) => p.entry.tag).join(', ')}`,
  );

  for (const { entry, hash, sqlText } of pending) {
    console.log(`\n>>> Applying ${entry.tag} (hash=${hash.slice(0, 12)}…) …`);
    const stmts = splitStatements(sqlText);

    await db.transaction(async (tx) => {
      for (const stmt of stmts) {
        await tx.execute(sql.raw(stmt));
      }
      await tx.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`,
      );
    });
    console.log(`  ✓ ${entry.tag} applied`);
  }

  // Repair `_journal.json` so future drizzle-kit migrate runs don't get
  // bitten by the same out-of-order `when` issue. We only adjust entries
  // whose `when` is not strictly increasing with idx; existing values
  // that are already monotonic stay unchanged.
  let lastWhen = -1;
  let mutated = false;
  for (const e of journal.entries) {
    if (e.when <= lastWhen) {
      e.when = lastWhen + 1;
      mutated = true;
    }
    lastWhen = e.when;
  }
  if (mutated) {
    writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2) + '\n');
    console.log(
      '\nUpdated _journal.json so `when` is monotonic with `idx` (prevents future silent skips).',
    );
  }

  await client.end({ timeout: 5 });
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
