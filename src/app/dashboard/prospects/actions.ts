'use server';

import { revalidatePath } from 'next/cache';

import { PROSPECT_STAGES, prospectInputSchema, type Actor } from '@/lib/prospects/rules';
import type { ProspectStage } from '@/db/schema';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { bulkReleaseClaims, claimProspect, reassignClaim, releaseProspect } from '@/lib/prospects/claims';
import { confirmImport, discardImport } from '@/lib/prospects/import/imports';
import { bulkPromote, MAX_BULK_PROMOTE, promoteProspect, type PromoteChoice, type PromoteOutcome } from '@/lib/prospects/promote/promote';
import { toggleVote, type VoteKind } from '@/lib/prospects/votes';
import type { Permission } from '@/lib/rbac';
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

async function gate(permission: Permission = 'manageProspects') {
  const g = await checkPermission(permission);
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

export async function claimProspectAction(id: string): Promise<ActionResult> {
  const g = await gate('claimProspects');
  if (!g.ok) return g;
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    claimProspect(g.tenantId, g.actor, String(id)),
  );
  if (r.ok) revalidatePath(BOARD_PATH);
  return toResult(r);
}

export async function releaseProspectAction(id: string): Promise<ActionResult> {
  const g = await gate('claimProspects');
  if (!g.ok) return g;
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    releaseProspect(g.tenantId, g.actor, String(id)),
  );
  if (r.ok) revalidatePath(BOARD_PATH);
  return toResult(r);
}

export async function reassignClaimAction(id: string, toUserId: string): Promise<ActionResult> {
  const g = await gate('manageProspectClaims');
  if (!g.ok) return g;
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    reassignClaim(g.tenantId, g.actor, String(id), String(toUserId)),
  );
  if (r.ok) revalidatePath(BOARD_PATH);
  return toResult(r);
}

export async function toggleVoteAction(
  id: string,
  kind: string,
): Promise<ActionResult<{ voted: boolean; knowSomeone: number; priority: number }>> {
  const g = await gate();
  if (!g.ok) return g;
  if (kind !== 'know_someone' && kind !== 'priority') return { ok: false, message: 'Unknown vote.' };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    toggleVote(g.tenantId, g.actor, String(id), kind as VoteKind),
  );
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath(BOARD_PATH);
  return { ok: true, data: { voted: r.voted, knowSomeone: r.knowSomeone, priority: r.priority } };
}

export async function bulkReleaseClaimsAction(
  ids: string[],
): Promise<ActionResult<{ released: number; skipped: { id: string; reason: string }[] }>> {
  const g = await gate('claimProspects');
  if (!g.ok) return g;
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, message: 'Select at least one prospect.' };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    bulkReleaseClaims(g.tenantId, g.actor, ids.map(String)),
  );
  revalidatePath(BOARD_PATH);
  return { ok: true, data: { released: r.released.length, skipped: r.skipped } };
}

/* ---------------- Promote to lead ---------------- */

const DEALS_PATH = '/dashboard/deals';

/** Only forward known, well-typed choice fields from the client. */
function cleanChoice(c: unknown): PromoteChoice {
  const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
  const id = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    leadId: id(o.leadId),
    companyId: id(o.companyId),
    contactId: id(o.contactId),
    createAnyway: o.createAnyway === true,
    ignoreWarnings: o.ignoreWarnings === true,
  };
}

export async function promoteProspectAction(id: string, choice?: PromoteChoice): Promise<ActionResult<PromoteOutcome>> {
  const g = await gate('promoteProspects');
  if (!g.ok) return g;
  const outcome = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    promoteProspect(g.tenantId, g.actor, String(id), cleanChoice(choice)),
  );
  if (outcome.status === 'promoted') {
    revalidatePath(BOARD_PATH);
    revalidatePath(DEALS_PATH);
  }
  return { ok: true, data: outcome };
}

export async function bulkPromoteAction(
  ids: string[],
  ignoreWarnings: boolean,
): Promise<ActionResult<{ results: { id: string; outcome: PromoteOutcome }[] }>> {
  const g = await gate('promoteProspects');
  if (!g.ok) return g;
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, message: 'Select at least one prospect.' };
  if (ids.length > MAX_BULK_PROMOTE) return { ok: false, message: `Promote at most ${MAX_BULK_PROMOTE} prospects at a time.` };
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    bulkPromote(g.tenantId, g.actor, ids.map(String), { ignoreWarnings: ignoreWarnings === true }),
  );
  revalidatePath(BOARD_PATH);
  revalidatePath(DEALS_PATH);
  return { ok: true, data: r };
}

/* ---------------- Quick Dump imports ---------------- */

export async function confirmImportAction(
  importId: string,
  rows: unknown[],
): Promise<ActionResult<{ inserted: number }> | { ok: false; message: string; rowErrors: { index: number; message: string }[] }> {
  const g = await gate();
  if (!g.ok) return g;
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    confirmImport(g.tenantId, g.actor, String(importId), Array.isArray(rows) ? rows : []),
  );
  if (!r.ok) return r.rowErrors ? { ok: false, message: r.message, rowErrors: r.rowErrors } : { ok: false, message: r.message };
  revalidatePath(BOARD_PATH);
  return { ok: true, data: { inserted: r.inserted } };
}

export async function discardImportAction(importId: string): Promise<ActionResult> {
  const g = await gate();
  if (!g.ok) return g;
  const r = await runWithTenantContext({ tenantId: g.tenantId, userId: g.actor.userId }, () =>
    discardImport(g.tenantId, g.actor, String(importId)),
  );
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}
