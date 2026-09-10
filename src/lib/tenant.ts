import 'server-only';

import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { cache } from 'react';

import { db } from '@/db';
import { memberships, tenants, type Tenant } from '@/db/schema';
import { ensureDefaultOwnerUserId } from '@/lib/auth/default-owner';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { seedDefaultOfferings } from '@/lib/offerings/queries';

/**
 * Tenant resolution for self-hosted auth. The active tenant is carried in
 * the session cookie as its UUID (`orgId` from `auth()`), so resolution is
 * a direct primary-key lookup — no Clerk org round-trip.
 */

// Memoized per request: the dashboard layout, page-level
// `withTenantSession`, and permission guards all resolve the active tenant
// in the same render pass. `cache()` collapses those into one DB hit.
export const getCurrentTenant = cache(async (): Promise<Tenant | null> => {
  const { orgId } = await auth();
  if (!orgId) return null;

  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, orgId))
    .limit(1);

  return row ?? null;
});

/**
 * Asserts a tenant is active. Throws if not — call from routes the
 * middleware has already gated on an active workspace.
 */
export async function requireTenant(): Promise<Tenant> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    throw new Error(
      'No active tenant. Select or create a workspace before loading this page.',
    );
  }
  return tenant;
}

/**
 * Backstop used by the dashboard layout. With local auth the tenant row
 * always exists for an active session, so this is just `getCurrentTenant`
 * — kept as a named export so the layout call site is unchanged.
 */
export async function ensureTenant(): Promise<Tenant | null> {
  return await getCurrentTenant();
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

/**
 * Create a new workspace and seat the creator as its owner. Used by the
 * "Create workspace" flow on /select-org (replaces Clerk's org-creation).
 */
export async function createTenant(input: {
  name: string;
  ownerUserId: string;
}): Promise<Tenant> {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: input.name.trim(), slug: slugify(input.name) })
    .returning();
  const row = tenant!;

  await runWithTenantContext(
    { tenantId: row.id, userId: input.ownerUserId },
    () =>
      tenantTransaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({
            tenantId: row.id,
            userId: input.ownerUserId,
            role: 'owner',
            status: 'active',
          })
          .onConflictDoNothing();
      }),
  );

  // Give the workspace the default Offerings catalog (0066). Migration 0066
  // seeded the tenants that already existed; this covers the ones created
  // after it ran. Best-effort: a workspace with no catalog is recoverable
  // from Settings → Offerings, whereas failing the whole creation over a
  // seed would leave the user with no workspace at all.
  try {
    await runWithTenantContext(
      { tenantId: row.id, userId: input.ownerUserId },
      () => seedDefaultOfferings(row.id),
    );
  } catch (err) {
    console.error('createTenant: offerings seed failed', err);
  }

  // Seat the default owner (info@cgbindia.com) on every new workspace too.
  const defaultOwnerId = await ensureDefaultOwnerUserId();
  if (defaultOwnerId !== input.ownerUserId) {
    await runWithTenantContext(
      { tenantId: row.id, userId: defaultOwnerId },
      () =>
        tenantTransaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({
              tenantId: row.id,
              userId: defaultOwnerId,
              role: 'owner',
              status: 'active',
            })
            .onConflictDoNothing();
        }),
    );
  }

  return row;
}
