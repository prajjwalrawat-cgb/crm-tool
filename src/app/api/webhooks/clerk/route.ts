import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { revalidatePath } from 'next/cache';
import { type NextRequest, NextResponse } from 'next/server';

import {
  removeMembershipFromClerk,
  upsertMembership,
  upsertMembershipFromClerk,
} from '@/lib/membership';
import {
  deleteTenantByClerkOrgId,
  updateTenantFromOrg,
  upsertTenantFromOrg,
} from '@/lib/tenant';

export async function POST(request: NextRequest) {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch (err) {
    console.error('[clerk webhook] signature verification failed:', err);
    return new NextResponse('Invalid signature', { status: 400 });
  }

  switch (event.type) {
    case 'organization.created': {
      const { id, name, slug, created_by } = event.data;
      const tenant = await upsertTenantFromOrg({
        id,
        name,
        slug: slug ?? null,
      });
      // Mint the Clerk org creator as our 'owner'. Clerk's built-in roles are
      // org:admin / org:member only — without this, no one would ever land
      // in the 'owner' bucket and `canManageRoles` would be unreachable.
      if (tenant && created_by) {
        await upsertMembership({
          tenantId: tenant.id,
          userId: created_by,
          role: 'owner',
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
      if (event.data.id) {
        await deleteTenantByClerkOrgId(event.data.id);
      }
      break;
    }
    case 'organizationMembership.created':
    case 'organizationMembership.updated': {
      const { organization, public_user_data, role } = event.data;
      // Backstop: ensure the tenant row exists in case this membership event
      // landed before its organization event (the webhook fan-out is unordered).
      await upsertTenantFromOrg({
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? null,
      });
      await upsertMembershipFromClerk({
        clerkOrgId: organization.id,
        clerkUserId: public_user_data.user_id,
        clerkRole: role,
      });
      revalidatePath('/dashboard/team');
      break;
    }
    case 'organizationMembership.deleted': {
      const { organization, public_user_data } = event.data;
      await removeMembershipFromClerk({
        clerkOrgId: organization.id,
        clerkUserId: public_user_data.user_id,
      });
      revalidatePath('/dashboard/team');
      break;
    }
    case 'organizationInvitation.created':
    case 'organizationInvitation.revoked': {
      // We don't mirror invitations into our DB — Clerk is the source of
      // truth for pending invites and the team page reads them live. Just
      // bust the route cache so the list reflects the change.
      revalidatePath('/dashboard/team');
      break;
    }
    default:
      // Ignore other event types; not part of the tenant model.
      break;
  }

  return NextResponse.json({ received: true });
}
