import 'server-only';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { tenants, type Tenant } from '@/db/schema';

type ClerkOrgSnapshot = {
  id: string;
  name: string;
  slug: string | null;
};

/**
 * Insert-or-fetch the tenant row matching a Clerk organization. Race-safe:
 * relies on the unique index on `clerk_org_id`. Returns the row on insert,
 * or the existing row if a concurrent request won the insert.
 *
 * Used by the Clerk webhook (where we already have org data) and by
 * ensureTenant() (which fetches via the Clerk SDK as a dev-time fallback).
 */
export async function upsertTenantFromOrg(org: ClerkOrgSnapshot): Promise<Tenant | null> {
  const [inserted] = await db
    .insert(tenants)
    .values({
      clerkOrgId: org.id,
      name: org.name,
      slug: org.slug ?? org.id,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.clerkOrgId, org.id))
    .limit(1);

  return existing ?? null;
}

/**
 * Apply later mutations from organization.updated webhook events. Returns
 * null if no row exists yet (caller can fall through to upsertTenantFromOrg).
 */
export async function updateTenantFromOrg(org: ClerkOrgSnapshot): Promise<Tenant | null> {
  const [updated] = await db
    .update(tenants)
    .set({ name: org.name, slug: org.slug ?? org.id })
    .where(eq(tenants.clerkOrgId, org.id))
    .returning();
  return updated ?? null;
}

/**
 * Delete a tenant by Clerk org id. Cascades to memberships/companies/contacts/
 * deals via the schema's ON DELETE CASCADE.
 */
export async function deleteTenantByClerkOrgId(orgId: string): Promise<void> {
  await db.delete(tenants).where(eq(tenants.clerkOrgId, orgId));
}

/**
 * Returns the tenant row matching the active Clerk organization, or null if
 * the user has no active org (or no row has been provisioned yet).
 */
export async function getCurrentTenant(): Promise<Tenant | null> {
  const { orgId } = await auth();
  if (!orgId) return null;

  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.clerkOrgId, orgId))
    .limit(1);

  return row ?? null;
}

/**
 * Asserts a tenant row exists for the active org. Throws if not — call from
 * routes that the middleware has already gated on `orgId`.
 */
export async function requireTenant(): Promise<Tenant> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    throw new Error(
      'No active tenant. Either no organization is selected, or the org has not been synced from Clerk yet.',
    );
  }
  return tenant;
}

/**
 * Returns the active tenant, lazily inserting from Clerk org metadata if the
 * webhook hasn't fired yet (e.g. local dev without ngrok). Race-safe via
 * upsertTenantFromOrg.
 */
export async function ensureTenant(): Promise<Tenant | null> {
  const { orgId } = await auth();
  if (!orgId) return null;

  const existing = await getCurrentTenant();
  if (existing) return existing;

  const client = await clerkClient();
  const org = await client.organizations.getOrganization({ organizationId: orgId });

  return await upsertTenantFromOrg({
    id: org.id,
    name: org.name,
    slug: org.slug ?? null,
  });
}
