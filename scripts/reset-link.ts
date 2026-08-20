import { config } from 'dotenv';
import { and, eq, isNull } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Mint a password-reset link out-of-band and print it, so an admin can hand
 * it over directly (Teams, phone) when email delivery is broken or the user
 * has no password yet at all.
 *
 * Uses the exact same token scheme as requestPasswordResetAction: a random
 * token is printed once, only its SHA-256 hash is stored. /reset-password
 * accepts it with no further changes.
 *
 *   pnpm reset:link someone@example.com
 *   pnpm reset:link someone@example.com --base-url https://crm.cgbindia.com
 *   pnpm reset:link someone@example.com --ttl 24 --invalidate
 *
 * Options:
 *   --base-url <url>  link origin (default: APP_URL). Required in practice —
 *                     APP_URL is localhost, which is useless to a remote user.
 *   --ttl <hours>     link lifetime in hours (default 1, matching the app).
 *   --invalidate      burn the user's other unused tokens first, so exactly
 *                     one live link exists.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const rawEmail = (process.argv[2] ?? '').trim();
  if (!rawEmail || !rawEmail.includes('@') || rawEmail.startsWith('--')) {
    console.error('Usage: pnpm reset:link <email> [--base-url <url>] [--ttl <hours>] [--invalidate]');
    process.exit(1);
  }
  const email = rawEmail.toLowerCase();

  const ttlHours = Number(arg('ttl') ?? '1');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    console.error(`Invalid --ttl: ${arg('ttl')}`);
    process.exit(1);
  }

  const { db, client } = await import('../src/db/index');
  const { users, passwordResetTokens } = await import('../src/db/schema');
  const { generateToken, hashToken } = await import('../src/lib/auth/tokens');

  const baseUrl = (arg('base-url') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );

  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    console.error(`No user row for ${email}. Nothing to reset.`);
    await client.end({ timeout: 5 });
    process.exit(1);
  }

  if (flag('invalidate')) {
    const burned = await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)),
      )
      .returning({ id: passwordResetTokens.id });
    console.log(`invalidated ${burned.length} outstanding token(s)`);
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

  console.log('');
  console.log(`user     : ${user.email} (${user.id})`);
  console.log(`action   : ${user.passwordHash ? 'reset existing password' : 'set FIRST password (migrated user)'}`);
  console.log(`expires  : ${expiresAt.toISOString()} (${ttlHours}h)`);
  console.log('');
  console.log(link);
  console.log('');

  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
    console.warn('⚠  This link points at localhost — it will only work on the machine');
    console.warn('   running the dev server. For a remote user pass --base-url with the');
    console.warn('   address they actually reach the app on.');
  }
  console.warn('⚠  This link is a one-time credential. Send it over a channel you trust');
  console.warn('   and tell them to use it before it expires.');

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('reset-link fatal:', err);
  process.exit(1);
});
