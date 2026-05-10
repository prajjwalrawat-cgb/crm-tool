import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { revalidatePath } from 'next/cache';
import { type NextRequest, NextResponse } from 'next/server';

import { runWithSystemContext } from '@/lib/db-context';
import {
  removeMembershipFromClerk,
  upsertMembership,
  upsertMembershipFromClerk,
} from '@/lib/membership';
import {
  captureError,
  incr,
  logger,
  runWithTrace,
} from '@/lib/observability';
import {
  deleteTenantByClerkOrgId,
  updateTenantFromOrg,
  upsertTenantFromOrg,
} from '@/lib/tenant';

/**
 * Clerk-driven mutations don't have a logged-in user — Svix verifies the
 * payload, then we trust it. To satisfy RLS on `memberships` (and any
 * future RLS-scoped writes from the webhook), each handler that touches
 * an RLS-enabled table runs inside `runWithSystemContext(tenantId)`.
 *
 * Tenant lookups + writes themselves are exempt: the `tenants` table is
 * deliberately not under RLS, so `upsertTenantFromOrg` etc. work without
 * a context.
 */
export async function POST(request: NextRequest) {
  return await runWithTrace(
    { origin: 'webhook', name: 'clerk' },
    () => handleClerkWebhook(request),
  );
}

async function handleClerkWebhook(request: NextRequest) {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch (err) {
    captureError(err, {
      category: 'webhook.clerk.verify',
      severity: 'high',
      retryable: false,
    });
    incr('webhook.clerk.invalid_signature');
    return new NextResponse('Invalid signature', { status: 400 });
  }
  incr('webhook.clerk.received', 1, { type: event.type });
  logger.info('clerk webhook received', { type: event.type });

  switch (event.type) {
    case 'organization.created': {
      const { id, name, slug, created_by } = event.data;
      const tenant = await upsertTenantFromOrg({
        id,
        name,
        slug: slug ?? null,
      });
      // Mint the Clerk org creator as our 'owner'. The membership write is
      // RLS-scoped, so it runs inside a system context bound to the new
      // tenant's id.
      if (tenant && created_by) {
        await runWithSystemContext(tenant.id, async () => {
          await upsertMembership({
            tenantId: tenant.id,
            userId: created_by,
            role: 'owner',
          });
        });
      }
      revalidatePath('/dashboard/team');
      break;
    }
    case 'organization.updated': {
      const { id, name, slug } = event.data;
      await updateTenantFromOrg({ id, name, slug: slug ?? null });
      break;
    }
    case 'organization.deleted': {
      // Cascade deletes everything (memberships, companies, contacts, deals,
      // activity_logs). The tenants row drop here doesn't go through RLS —
      // tenants is not RLS-scoped, and the cascading deletes also skip RLS
      // because they're driven by the FK action, not an app DELETE.
      if (event.data.id) {
        await deleteTenantByClerkOrgId(event.data.id);
      }
      break;
    }
    case 'organizationMembership.created':
    case 'organizationMembership.updated': {
      const { organization, public_user_data, role } = event.data;
      // Backstop: ensure the tenant row exists (out-of-order webhook delivery
      // defense). This still doesn't need a context — tenants is unrestricted.
      const tenant = await upsertTenantFromOrg({
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? null,
      });
      if (tenant) {
        await runWithSystemContext(tenant.id, async () => {
          await upsertMembershipFromClerk({
            clerkOrgId: organization.id,
            clerkUserId: public_user_data.user_id,
            clerkRole: role,
          });
        });
      }
      revalidatePath('/dashboard/team');
      break;
    }
    case 'organizationMembership.deleted': {
      const { organization, public_user_data } = event.data;
      // upsertTenantFromOrg here only to extract a tenantId for the system
      // context; if the tenant is gone the membership delete is a no-op.
      const tenant = await upsertTenantFromOrg({
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? null,
      });
      if (tenant) {
        await runWithSystemContext(tenant.id, async () => {
          await removeMembershipFromClerk({
            clerkOrgId: organization.id,
            clerkUserId: public_user_data.user_id,
          });
        });
      }
      revalidatePath('/dashboard/team');
      break;
    }
    case 'organizationInvitation.created':
    case 'organizationInvitation.revoked': {
      // We don't mirror invitations into our DB; just bust the team page
      // cache so the live invite list updates.
      revalidatePath('/dashboard/team');
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
