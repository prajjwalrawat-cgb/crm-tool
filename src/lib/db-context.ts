import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * Sentinel actor used by webhooks and other server-driven mutations that
 * don't have a logged-in user. Activity log rows produced under this actor
 * carry it through `metadata.actor_user_id`; UI formatters can choose how
 * to surface "system" attribution.
 */
export const SYSTEM_ACTOR_ID = 'system';

export type TenantContext = {
  /** UUID of the active tenant. Drives the `app.tenant_id` GUC. */
  tenantId: string;
  /** Clerk user id of the actor, or `SYSTEM_ACTOR_ID`. Drives `app.user_id`. */
  userId: string;
  /**
   * When true, the SELECT policies for companies/contacts/deals also surface
   * soft-deleted rows. Set only by the recently-deleted view path; defaults
   * to false everywhere else.
   */
  includeDeleted?: boolean;
  /** True iff entered via runWithSystemContext (webhook / cron). */
  isSystem?: boolean;
};

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const contextStore = new AsyncLocalStorage<TenantContext>();

/**
 * Read the active tenant context, or `undefined` if none has been entered.
 * Use this from query helpers to decide whether to fail loudly or skip a
 * branch (rare); most code should call `requireTenantContext()`.
 */
export function getTenantContext(): TenantContext | undefined {
  return contextStore.getStore();
}

/**
 * Asserts the caller is inside a tenant context. Failure here is a wiring
 * bug — a code path executed an RLS-scoped query without entering
 * `runWithTenantContext` first. With our policies, the underlying SQL would
 * succeed but return zero rows; throwing makes the bug loud during dev.
 */
export function requireTenantContext(): TenantContext {
  const ctx = contextStore.getStore();
  if (!ctx) {
    throw new Error(
      'No tenant context. Wrap the call site in runWithTenantContext or runWithSystemContext.',
    );
  }
  return ctx;
}

/**
 * Enter a tenant context for the duration of `fn`. Every nested call —
 * including descendants spawned via Promise.all, setTimeout, etc. — sees
 * the same `(tenantId, userId)` via AsyncLocalStorage propagation.
 *
 * The context itself does NOT touch the database. The GUCs are set lazily,
 * inside `tenantTransaction(...)`, so an entry-point can establish context
 * even if it doesn't end up issuing a query.
 */
export async function runWithTenantContext<T>(
  context: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return await contextStore.run(context, fn);
}

/**
 * Enter a system-actor context. Used by the Clerk webhook handler and any
 * other path where the mutation is server-driven without a user session.
 * Activity log entries written under this context carry the SYSTEM_ACTOR_ID
 * so the audit trail still attributes them.
 */
export async function runWithSystemContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await contextStore.run(
    { tenantId, userId: SYSTEM_ACTOR_ID, isSystem: true },
    fn,
  );
}

/**
 * Re-enter the existing context with `includeDeleted: true`. Used by the
 * recently-deleted page so its `listDeleted*` queries can see soft-deleted
 * rows; under the default context they're masked by the SELECT policy.
 */
export async function withIncludeDeleted<T>(fn: () => Promise<T>): Promise<T> {
  const current = requireTenantContext();
  return await contextStore.run({ ...current, includeDeleted: true }, fn);
}

/**
 * Open a Postgres transaction whose first statements:
 *   1. drop the connection's effective role to `app_user` (`SET LOCAL ROLE`)
 *      so RLS *actually* applies — Supabase's `postgres` connection role is
 *      a SUPERUSER and would otherwise bypass policies regardless of FORCE
 *      ROW LEVEL SECURITY.
 *   2. set the tenant-scope GUCs the policies read (`app.tenant_id`,
 *      `app.user_id`, optionally `app.include_deleted`).
 *
 * All four statements use transaction-local scope (`SET LOCAL` / the third
 * arg to `set_config` being `true`), so they reset at COMMIT/ROLLBACK. This
 * is what makes the helper safe under Supabase's transaction-mode pooler:
 * the connection returns to the pool with its identity restored to
 * `postgres` and no leftover GUCs to leak between tenants.
 *
 * Use this for any read or write that touches an RLS-enabled table. Reads
 * are wrapped in single-statement transactions; the overhead is dominated
 * by the query itself.
 */
export async function tenantTransaction<T>(
  fn: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  const ctx = requireTenantContext();
  return await db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true)`,
    );
    if (ctx.includeDeleted) {
      await tx.execute(
        sql`select set_config('app.include_deleted', 'true', true)`,
      );
    }
    return await fn(tx);
  });
}

/**
 * Escape hatch for the rare admin paths that legitimately need to bypass
 * RLS. Today we don't ship one — webhooks set tenant context per event,
 * scripts run as the service role outside Next.js, and no in-app code path
 * needs cross-tenant reads. Exported only so future use is grep-able and
 * intentional.
 */
export type DbExecutor = typeof db | DrizzleTx;
