import { config } from 'dotenv';

config({ path: '.env.local' });
config();

/**
 * Diagnostic: verifies SMTP credentials and (optionally) sends a real
 * test email through the configured Nodemailer transport. Used to
 * smoke-test a Gmail App Password or any custom SMTP relay before
 * flipping production traffic onto it.
 *
 * Usage:
 *   pnpm tsx scripts/test-smtp.ts                    # verify connection only
 *   pnpm tsx scripts/test-smtp.ts --to alice@x.com   # also send a real test
 *
 * Never commits anything to the database. Reads SMTP_* + EMAIL_FROM
 * from the active env. Credentials never appear in stdout — username
 * is masked to first 3 chars + domain.
 */

async function main(): Promise<void> {
  // Dynamic imports so dotenv config above runs first.
  const { readNodemailerConfig } = await import(
    '../src/lib/email/providers/factory'
  );
  const { NodemailerEmailProvider } = await import(
    '../src/lib/email/providers/nodemailer-provider'
  );

  const toArg = process.argv.indexOf('--to');
  const toAddress = toArg !== -1 ? process.argv[toArg + 1] : undefined;

  const cfg = readNodemailerConfig();
  if (!cfg) {
    console.error('❌ SMTP config incomplete. Need all of:');
    console.error('   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD');
    console.error('Current env state:');
    console.error('   SMTP_HOST    =', mask(process.env.SMTP_HOST));
    console.error('   SMTP_PORT    =', process.env.SMTP_PORT ?? '(unset)');
    console.error('   SMTP_USER    =', maskUser(process.env.SMTP_USER));
    console.error(
      '   SMTP_PASSWORD=',
      process.env.SMTP_PASSWORD ? '****** (set)' : '(unset)',
    );
    console.error('   SMTP_SECURE  =', process.env.SMTP_SECURE ?? '(default by port)');
    console.error('   EMAIL_FROM   =', process.env.EMAIL_FROM ?? '(unset)');
    process.exit(1);
  }

  console.log('SMTP config:');
  console.log('   host  =', cfg.host);
  console.log('   port  =', cfg.port);
  console.log('   user  =', maskUser(cfg.user));
  console.log('   secure=', cfg.secure);
  console.log('   from  =', process.env.EMAIL_FROM ?? '(EMAIL_FROM unset)');
  console.log('');

  const provider = new NodemailerEmailProvider(cfg);

  console.log('▶ Verifying SMTP connection…');
  const verify = await provider.verifyConnection();
  if (!verify.ok) {
    console.error('❌ SMTP verify failed:', verify.reason);
    console.error('');
    console.error('Common fixes:');
    console.error(
      '  - Gmail: use an App Password, not your account password. https://myaccount.google.com/apppasswords',
    );
    console.error(
      '  - Gmail: make sure 2-Step Verification is enabled on the account.',
    );
    console.error(
      '  - Port 465 → SMTP_SECURE=true. Port 587 → SMTP_SECURE=false.',
    );
    console.error(
      '  - Some networks block outbound SMTP; try from a different network if connection times out.',
    );
    process.exit(1);
  }
  console.log('✅ SMTP connection verified.');

  if (!toAddress) {
    console.log('');
    console.log(
      'No --to address provided — skipping the actual send. Pass --to <email> to also send a real test message.',
    );
    return;
  }

  console.log(`▶ Sending test email to ${toAddress}…`);
  const result = await provider.send({
    from: process.env.EMAIL_FROM ?? cfg.user,
    to: [toAddress],
    cc: [],
    bcc: [],
    subject: 'CRM SMTP test',
    text:
      `This is a diagnostic test email sent by scripts/test-smtp.ts.\n\n` +
      `If you received this, your Nodemailer SMTP transport is working.\n\n` +
      `Host: ${cfg.host}\nPort: ${cfg.port}\nSent at: ${new Date().toISOString()}`,
    html: null,
    idempotencyKey: `smtp-test-${Date.now()}`,
  });

  if (result.status === 'accepted') {
    console.log('✅ Test email accepted by the SMTP server.');
    console.log('   provider message id:', result.providerMessageId ?? '(none)');
    console.log('   Check your inbox (and spam folder).');
  } else {
    console.error('❌ Send rejected:');
    console.error('   reason   :', result.reason);
    console.error('   retryable:', result.retryable);
    process.exit(2);
  }
}

function mask(v: string | undefined): string {
  if (!v) return '(unset)';
  if (v.length <= 4) return '****';
  return v.slice(0, 4) + '***';
}

function maskUser(v: string | undefined): string {
  if (!v) return '(unset)';
  if (!v.includes('@')) return v.slice(0, 3) + '***';
  const [local, domain] = v.split('@', 2);
  if (!local || !domain) return '***';
  return `${local.slice(0, 3)}***@${domain}`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('💥 Fatal:', err);
    process.exit(99);
  });
