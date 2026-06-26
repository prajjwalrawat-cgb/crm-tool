'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db';
import {
  companies,
  contacts,
  deals,
  memberships,
  proformaInvoices,
  tasks,
  tenants,
} from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { setSession } from '@/lib/auth/session';
import { isOwnerOf } from '@/lib/auth/workspaces';

export type OrgActionResult = { ok: true } | { ok: false; error: string };

export type WorkspaceStats = {
  companies: number;
  contacts: number;
  deals: number;
  invoices: number;
  tasks: number;
  members: number;
};

/**
 * Row counts for the headline entities in a workspace — shown in the delete
 * confirmation so the owner sees what will be removed. Owner-of-target only.
 * Runs on the base connection (superuser, bypasses RLS) with explicit
 * tenant filters, mirroring the other cross-tenant identity queries.
 */
export async function getWorkspaceStatsAction(
  tenantId: string,
): Promise<WorkspaceStats | null> {
  const { userId } = await auth();
  if (!userId) return null;
  if (!z.uuid().safeParse(tenantId).success) return null;
  if (!(await isOwnerOf(userId, tenantId))) return null;

  const n = sql<number>`count(*)::int`;
  const [comp, cont, deal, inv, task, mem] = await Promise.all([
    db.select({ n }).from(companies).where(eq(companies.tenantId, tenantId)),
    db.select({ n }).from(contacts).where(eq(contacts.tenantId, tenantId)),
    db.select({ n }).from(deals).where(eq(deals.tenantId, tenantId)),
    db.select({ n }).from(proformaInvoices).where(eq(proformaInvoices.tenantId, tenantId)),
    db.select({ n }).from(tasks).where(eq(tasks.tenantId, tenantId)),
    db.select({ n }).from(memberships).where(eq(memberships.tenantId, tenantId)),
  ]);

  return {
    companies: comp[0]?.n ?? 0,
    contacts: cont[0]?.n ?? 0,
    deals: deal[0]?.n ?? 0,
    invoices: inv[0]?.n ?? 0,
    tasks: task[0]?.n ?? 0,
    members: mem[0]?.n ?? 0,
  };
}

const nameSchema = z.string().trim().min(2, 'Use at least 2 characters').max(80);

/** Rename a workspace. Owner-of-target only. */
export async function renameWorkspaceAction(
  tenantId: string,
  name: string,
): Promise<OrgActionResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  if (!z.uuid().safeParse(tenantId).success) {
    return { ok: false, error: 'Invalid workspace.' };
  }
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid name.' };
  }
  if (!(await isOwnerOf(userId, tenantId))) {
    return { ok: false, error: 'Only an owner can rename this workspace.' };
  }

  // `tenants` is not RLS-scoped, so this runs on the base connection.
  await db.update(tenants).set({ name: parsed.data }).where(eq(tenants.id, tenantId));
  revalidatePath('/dashboard/organizations');
  revalidatePath('/dashboard');
  return { ok: true };
}

/**
 * Delete a workspace and ALL of its data (cascade). Owner-of-target only.
 * If the deleted workspace was the active one, the session is moved to
 * another workspace (or cleared) and the user is redirected.
 */
export async function deleteWorkspaceAction(
  tenantId: string,
): Promise<OrgActionResult> {
  const { userId, orgId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  if (!z.uuid().safeParse(tenantId).success) {
    return { ok: false, error: 'Invalid workspace.' };
  }
  if (!(await isOwnerOf(userId, tenantId))) {
    return { ok: false, error: 'Only an owner can delete this workspace.' };
  }

  // FK ON DELETE CASCADE removes memberships, companies, contacts, deals,
  // invoices, activity, etc. for this tenant.
  await db.delete(tenants).where(eq(tenants.id, tenantId));

  if (orgId === tenantId) {
    // Fresh query (NOT the cached listUserWorkspaces) — the deleted tenant's
    // memberships are already gone via cascade.
    const [next] = await db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    await setSession({ sub: userId, tid: next?.tenantId ?? null });
    redirect(next ? '/dashboard/organizations' : '/select-org');
  }

  revalidatePath('/dashboard/organizations');
  return { ok: true };
}
