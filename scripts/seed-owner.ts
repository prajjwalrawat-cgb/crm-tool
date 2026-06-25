import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

config({ path: '.env.local' });
config();

/**
 * Seed info@cgbindia.com as an owner of every existing workspace.
 * Idempotent: re-running upgrades the membership to owner without
 * duplicating rows. The account is created passwordless — the person
 * sets a password via the "Forgot password" flow on first sign-in.
 *
 * Run: pnpm seed:owner
 *
 * (New workspaces seat this owner automatically — see src/lib/tenant.ts.)
 */
const EMAIL = 'info@cgbindia.com';

async function main() {
  const { db, client } = await import('../src/db/index');
  const { users, memberships, tenants } = await import('../src/db/schema');

  // Ensure the user (plain `db` runs as superuser — bypasses RLS, which is
  // what we want for cross-tenant seeding).
  let [user] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        id: `usr_${randomBytes(16).toString('hex')}`,
        email: EMAIL,
        passwordHash: null,
        emailVerified: false,
      })
      .returning();
    console.log(`created user ${EMAIL} (${user!.id})`);
  } else {
    console.log(`user ${EMAIL} already exists (${user.id})`);
  }
  const userId = user!.id;

  const allTenants = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants);

  for (const t of allTenants) {
    await db
      .insert(memberships)
      .values({ tenantId: t.id, userId, role: 'owner', status: 'active' })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { role: 'owner', status: 'active' },
      });
    console.log(`  ✓ owner of "${t.name}"`);
  }

  console.log(
    `\nDone. ${EMAIL} is an owner of ${allTenants.length} workspace(s).`,
  );
  console.log(
    'Next: have them use "Forgot password" on the sign-in page to set a password.',
  );
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed-owner fatal:', err);
  process.exit(1);
});
