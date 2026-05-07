import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { type NextRequest, NextResponse } from 'next/server';

import {
  removeMembershipFromClerk,
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
      const { id, name, slug } = event.data;
      await upsertTenantFromOrg({ id, name, slug: slug ?? null });
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
      // Same payload shape for both — we upsert on (tenant_id, user_id).
      const { organization, public_user_data, role } = event.data;
      // Backfill the tenant first in case the membership event lands before
      // the organization event (the webhook fan-out has no order guarantee).
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
      break;
    }
    case 'organizationMembership.deleted': {
      const { organization, public_user_data } = event.data;
      await removeMembershipFromClerk({
        clerkOrgId: organization.id,
        clerkUserId: public_user_data.user_id,
      });
      break;
    }
    default:
      // Ignore other event types; they're not part of the tenant model.
      break;
  }

  return NextResponse.json({ received: true });
}
