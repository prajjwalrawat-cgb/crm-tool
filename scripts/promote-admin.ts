import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * Promote a user to `admin` on every workspace (tenant). Idempotent:
 *   - creates an active admin membership where none exists,
 *   - upgrades an existing member/viewer/manager to admin,
 *   - NEVER downgrades an existing `owner`.
 *
 * Runs as the migration DB role (bypasses RLS) so it can write across tenants,
 * same as scripts/seed-owner.ts.
 *
 *   pnpm tsx scripts/promote-admin.ts                       # default email
 *   pnpm tsx scripts/promote-admin.ts someone@example.com   # explicit email
 */
const DEFAULT_EMAIL = 'prajjwal.rawat@cgbindia.com';

async function main() {
  const { db, client } = await import('../src/db/index');
  const { users, tenants, memberships } = await import('../src/db/schema');

  const email = (process.argv[2] || DEFAULT_EMAIL).trim().toLowerCase();

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (!user) {
    console.error(`No user found for ${email}. Sign in once so the user row exists.`);
    await client.end({ timeout: 5 });
    process.exit(1);
  }
  console.log(`user ${user.email} → ${user.id}`);

  const allTenants = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants);

  for (const t of allTenants) {
    await db
      .insert(memberships)
      .values({ tenantId: t.id, userId: user.id, role: 'admin', status: 'active' })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: {
          // Preserve owner; otherwise promote to admin. Reactivate too.
          role: sql`CASE WHEN ${memberships.role} = 'owner' THEN 'owner'::membership_role ELSE 'admin'::membership_role END`,
          status: 'active',
          updatedAt: new Date(),
        },
      });

    const [row] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        sql`${memberships.tenantId} = ${t.id} AND ${memberships.userId} = ${user.id}`,
      )
      .limit(1);
    console.log(`  ${t.name}: role=${row?.role}`);
  }

  console.log(`done. ${email} is admin (or owner) on ${allTenants.length} workspace(s).`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('promote fatal:', err);
  process.exit(1);
});
