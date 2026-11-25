import 'server-only';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { getCurrentMembership } from '@/lib/membership';
import { captureError } from '@/lib/observability';
import { getCurrentTenant } from '@/lib/tenant';
import type { FieldActor } from '@/lib/field/types';

import { errorBody, fieldErrorResponse, jsonResponse, setFieldErrorReporter } from './http';

setFieldErrorReporter((err) => captureError(err, { category: 'field.route_failed', severity: 'medium' }));

/**
 * auth, tenant, active membership, then run `fn` under the tenant context.
 * Scope / owner / pinFieldSites checks live in the service. `fn` returns the
 * JSON payload (200) or a ready Response; thrown errors are mapped.
 */
export async function withFieldActor(fn: (actor: FieldActor) => Promise<unknown>): Promise<Response> {
  try {
    // Inside the try: an auth or tenant lookup failure maps to the JSON 500 and is reported.
    const { userId } = await auth();
    if (!userId) return errorBody('Sign in again to continue.', 401);
    const tenant = await getCurrentTenant();
    if (!tenant) return errorBody('Choose a workspace first.', 401);

    return await runWithTenantContext({ tenantId: tenant.id, userId }, async () => {
      const membership = await getCurrentMembership();
      if (!membership || membership.status !== 'active') return errorBody('You do not have permission.', 403);
      const out = await fn({ tenantId: tenant.id, userId, role: membership.role });
      return out instanceof Response ? out : jsonResponse(out);
    });
  } catch (err) {
    return fieldErrorResponse(err);
  }
}

export type IdCtx = { params: Promise<{ id: string }> };
