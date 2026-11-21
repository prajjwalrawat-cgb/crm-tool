'use server';

import { revalidatePath } from 'next/cache';

import { PROSPECT_STAGES, prospectInputSchema, type Actor } from '@/lib/prospects/rules';
import type { ProspectStage } from '@/db/schema';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import {
  bulkMoveStage,
  createProspect,
  moveProspectStage,
  updateProspect,
  type MutationResult,
} from '@/lib/prospects/mutations';

/**
 * Prospect Board server actions. Every action is gated on `manageProspects`
 * and runs inside the tenant context; stage-move guards (claims, promoted,
 * deleted) are enforced again in the mutations layer.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; message: string };

const BOARD_PATH = '/dashboard/prospects';

const isStage = (v: string): v is ProspectStage => (PROSPECT_STAGES as readonly string[]).includes(v);

async function gate() {
  const g = await checkPermission('manageProspects');
  if (!g.ok) return { ok: false as const, message: g.message };
  const actor: Actor = { userId: g.membership.userId, role: g.membership.role };
  return { ok: true as const, tenantId: g.tenant.id, actor };
}

function toResult(r: MutationResult): ActionResult {
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

export async function createProspectAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = prospectInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the prospect details and try again.' };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    createProspect(g.tenantId, g.actor, parsed.data),
  );
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(BOARD_PATH);
  return { ok: true, data: { id: r.id } };
}

export async function updateProspectAction(id: string, input: unknown): Promise<ActionResult> {
  const g = await gate();
  if (!g.ok) return g;
  const parsed = prospectInputSchema.partial().safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the prospect details and try again.' };
  // Only forward keys the caller actually sent; the schema's transforms turn
  // missing optional fields into null and would otherwise wipe them.
  const sent = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const partial = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k in sent));
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    updateProspect(g.tenantId, g.actor, id, partial),
  );
  if (r.ok) revalidatePath(BOARD_PATH);
  return toResult(r);
}

export async function moveProspectStageAction(id: string, to: string): Promise<ActionResult> {
  const g = await gate();
  if (!g.ok) return g;
  if (!isStage(to)) return { ok: false, message: 'Unknown stage.' };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    moveProspectStage(g.tenantId, g.actor, id, to),
  );
  if (r.ok) revalidatePath(BOARD_PATH);
  return toResult(r);
}

export async function bulkMoveStageAction(
  ids: string[],
  to: string,
): Promise<ActionResult<{ moved: number; skipped: { id: string; reason: string }[] }>> {
  const g = await gate();
  if (!g.ok) return g;
  if (!isStage(to)) return { ok: false, message: 'Unknown stage.' };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, message: 'Select at least one prospect.' };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    bulkMoveStage(g.tenantId, g.actor, ids.map(String), to),
  );
  revalidatePath(BOARD_PATH);
  return { ok: true, data: { moved: r.moved.length, skipped: r.skipped } };
}
