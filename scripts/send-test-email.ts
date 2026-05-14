import { config } from 'dotenv';

config({ path: '.env.local' });
config();

/**
 * Send a real email through the production CRM pipeline. Unlike
 * scripts/test-smtp.ts (which calls the provider directly), this
 * exercises the full `deliverEmail()` state machine:
 *
 *   queued → sending → sent | failed
 *
 * Also writes the email_messages row, fires the activity log entry,
 * and the result is visible on /dashboard/email and the linked deal's
 * timeline. The point: prove the production code path works, not just
 * the SMTP transport.
 *
 * Usage:
 *   pnpm tsx scripts/send-test-email.ts --to alice@example.com
 *
 * Optional:
 *   --subject "..."           override subject
 *   --tenant "Test 1"         pick a different tenant (default: Test 1)
 *   --no-deal                 send without linking to a deal
 *
 * Tenant guard: only attaches to a tenant on the demo allowlist
 * (`scripts/demo-allowlist.ts`). Refuses to write a test email row
 * into a production tenant.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const to = arg('to');
  if (!to || !/.+@.+\..+/.test(to)) {
    console.error('❌ Usage: pnpm tsx scripts/send-test-email.ts --to <email>');
    process.exit(1);
  }
  const subject =
    arg('subject') ?? `CRM end-to-end email test · ${new Date().toISOString().slice(0, 19)}`;
  const tenantName = arg('tenant') ?? 'Test 1';
  const skipDealLink = flag('no-deal');

  // Dynamic imports so .env.local has loaded first.
  const { sql } = await import('drizzle-orm');
  const { db, client } = await import('../src/db/index');
  const { DEMO_TENANT_NAMES } = await import('./demo-allowlist');
  const { runWithTenantContext, tenantTransaction } = await import(
    '../src/lib/db-context'
  );
  const { emailMessages } = await import('../src/db/schema');
  const { deliverEmail } = await import('../src/lib/email/sender');
  const { getEmailProvider, getSenderIdentity } = await import(
    '../src/lib/email/providers/factory'
  );

  // Tenant guard — never let this script touch a non-demo tenant.
  if (!DEMO_TENANT_NAMES.includes(tenantName)) {
    console.error(
      `❌ Refusing to send test email into "${tenantName}" — only demo tenants on the allowlist are permitted: ${DEMO_TENANT_NAMES.join(', ')}`,
    );
    process.exit(2);
  }

  type TenantRow = { id: string; name: string };
  const [tenant] = (await db.execute(
    sql`SELECT id, name FROM tenants WHERE name = ${tenantName} LIMIT 1`,
  )) as unknown as TenantRow[];
  if (!tenant) {
    console.error(`❌ Tenant "${tenantName}" not found. Run seed:demo first.`);
    process.exit(3);
  }

  // Find a real deal in the tenant to attach the email to. Without an
  // entity link the row still works but won't surface on a detail page.
  let dealId: string | null = null;
  let dealName: string | null = null;
  if (!skipDealLink) {
    type DealRow = { id: string; name: string };
    const [deal] = (await db.execute(
      sql`SELECT id, name FROM deals WHERE tenant_id = ${tenant.id}::uuid AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )) as unknown as DealRow[];
    if (deal) {
      dealId = deal.id;
      dealName = deal.name;
    }
  }

  const provider = getEmailProvider();
  console.log('Pipeline configuration:');
  console.log(`  tenant  : ${tenant.name} (${tenant.id})`);
  console.log(`  provider: ${provider.name}`);
  console.log(`  sender  : ${getSenderIdentity()}`);
  if (dealId) {
    console.log(`  attached to deal: ${dealName} (${dealId})`);
  } else {
    console.log('  (no deal link — email will appear on /dashboard/email only)');
  }
  console.log('');

  if (provider.name === 'console') {
    console.warn(
      '⚠  EMAIL_PROVIDER is not set to a real transport — message will be logged only, not delivered.',
    );
    console.warn(
      '   Set EMAIL_PROVIDER=nodemailer and SMTP_* in .env.local, then re-run.',
    );
  }

  // Step 1: write the queued row. We use a generated actor id so RLS
  // is happy (tenant-scoped) without needing a real Clerk session.
  const actorUserId = 'script-send-test-email';
  const idempotencyKey = `send-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const queuedId = await runWithTenantContext(
    { tenantId: tenant.id, userId: actorUserId },
    async () =>
      tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(emailMessages)
          .values({
            tenantId: tenant.id,
            actorUserId,
            provider: provider.name,
            direction: 'outbound',
            status: 'queued',
            subject,
            textBody:
              'This message was sent by scripts/send-test-email.ts to verify the end-to-end CRM email pipeline.\n\n' +
              `Tenant: ${tenant.name}\n` +
              (dealName ? `Linked deal: ${dealName}\n` : '') +
              `Provider: ${provider.name}\n` +
              `Sent at: ${new Date().toISOString()}\n\n` +
              'If you received this, deliverEmail() + the SMTP transport are both healthy.',
            htmlBody: null,
            sender: getSenderIdentity(),
            toRecipients: [to],
            ccRecipients: [],
            bccRecipients: [],
            entityType: dealId ? 'deal' : null,
            entityId: dealId,
            idempotencyKey,
            metadata: { sentBy: 'send-test-email-script' },
          })
          .returning();
        if (!row) throw new Error('Failed to insert queued email row');
        return row.id;
      }),
  );

  console.log(`▶ Queued email row id: ${queuedId}`);
  console.log('▶ Calling deliverEmail()…');

  const outcome = await runWithTenantContext(
    { tenantId: tenant.id, userId: actorUserId },
    async () => deliverEmail(tenant.id, queuedId),
  );

  if (outcome.status === 'sent') {
    console.log('');
    console.log('✅ Email delivered.');
    console.log(`   provider message id: ${outcome.providerMessageId ?? '(none)'}`);
    console.log(`   transport          : ${outcome.providerName}`);
    if (dealId) {
      console.log(`   visible at         : /dashboard/deals/${dealId}`);
    }
    console.log('   global view        : /dashboard/email');
    console.log('   Check the recipient inbox (and spam folder).');
  } else {
    console.error('');
    console.error('❌ Send failed.');
    console.error(`   reason   : ${outcome.reason}`);
    console.error(`   retryable: ${outcome.retryable}`);
    console.error(`   transport: ${outcome.providerName}`);
    console.error('');
    console.error('The row is in the failed state and visible on /dashboard/email');
    console.error('with the inline Retry button when retry budget remains.');
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('💥 Fatal:', err);
  process.exit(99);
});
