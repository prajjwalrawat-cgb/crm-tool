import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * One-off backfill for 0072: fill contacts.phone_normalized (E.164) from
 * contacts.phone so lead-capture dedupe also matches contacts created before
 * capture existed. Idempotent; only touches rows where it is NULL. Runs as
 * the table owner (maintenance script), in batches.
 *
 *   tsx scripts/backfill-contact-phones.ts [--dry-run]
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { db, client } = await import('../src/db/index');
  const { normalizePhone } = await import('../src/lib/lead-capture/normalize');
  let lastId = '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  let filled = 0;
  for (;;) {
    const rows = (await db.execute(sql`
      select id, phone from contacts
      where phone_normalized is null and phone is not null and btrim(phone) <> '' and id > ${lastId}::uuid
      order by id limit 500`)) as unknown as Array<{ id: string; phone: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned++;
      const n = normalizePhone(r.phone);
      if (n) {
        filled++;
        if (!dryRun) await db.execute(sql`update contacts set phone_normalized = ${n} where id = ${r.id}::uuid and phone_normalized is null`);
      }
    }
    lastId = rows[rows.length - 1]!.id;
  }
  console.log(`${dryRun ? '[dry run] ' : ''}scanned ${scanned}, normalized ${filled}, unparseable ${scanned - filled}`);
  await client.end({ timeout: 5 });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
