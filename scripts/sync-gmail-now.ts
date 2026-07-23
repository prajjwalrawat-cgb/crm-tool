import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Run the Gmail sync ONCE, on demand, for every connected mailbox — so you can
 * connect on the Email Sync settings page and immediately see captured emails
 * land on deals, without waiting for the 10-minute Inngest cron or running
 * `pnpm inngest:dev`.
 *
 *   pnpm gmail:sync-now                 # all connected mailboxes, all tenants
 *   pnpm gmail:sync-now <tenant-uuid>   # just one workspace
 *
 * Requires the Gmail env (GMAIL_CLIENT_ID/SECRET/redirect + EMAIL_SYNC_ENCRYPTION_KEY)
 * to be set — the same vars the live sync needs.
 */
type TenantRow = { id: string; name: string };

async function main() {
  const { db, client } = await import('../src/db/index');
  const { tenants } = await import('../src/db/schema');
  const { runWithSystemContext } = await import('../src/lib/db-context');
  const { gmailConfigured } = await import('../src/lib/email/gmail/client');
  const { listActiveConnectionsForTenant } = await import(
    '../src/lib/email/gmail/connections'
  );
  const { syncMailbox } = await import('../src/lib/email/gmail/sync');

  if (!gmailConfigured()) {
    console.error(
      'Gmail is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_OAUTH_REDIRECT_URI and EMAIL_SYNC_ENCRYPTION_KEY in .env.local first.',
    );
    await client.end({ timeout: 5 });
    process.exit(1);
  }

  const tenantArg = process.argv[2]?.trim();
  const rows = (await db.execute(
    tenantArg
      ? sql`SELECT id, name FROM tenants WHERE id = ${tenantArg}::uuid`
      : sql`SELECT id, name FROM tenants ORDER BY created_at`,
  )) as unknown as TenantRow[];

  let mailboxes = 0;
  for (const t of rows) {
    const conns = await runWithSystemContext(t.id, () =>
      listActiveConnectionsForTenant(t.id),
    );
    for (const conn of conns) {
      mailboxes += 1;
      process.stdout.write(`syncing ${conn.email} (${t.name})... `);
      try {
        const stats = await runWithSystemContext(t.id, () =>
          syncMailbox(t.id, conn),
        );
        console.log(
          `processed=${stats.processed} created=${stats.created} duplicates=${stats.duplicates} skipped=${stats.skipped}`,
        );
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (mailboxes === 0) {
    console.log(
      'No connected mailboxes found. Connect Gmail on Settings → Email sync first.',
    );
  } else {
    console.log(`\ndone. synced ${mailboxes} mailbox(es).`);
  }
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('sync fatal:', err);
  process.exit(1);
});
