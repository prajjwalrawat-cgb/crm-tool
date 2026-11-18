'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { withTenantSession } from '@/lib/auth-guard';
import { defaultAppliers } from '@/lib/ai/suggestions/appliers';
import { decideSuggestion, type DecideResult } from '@/lib/ai/suggestions/service';
import { requireMembership } from '@/lib/membership';

/**
 * Review actions for AI suggestions. They run as the signed-in user: the
 * suggestion must be in their scope (own records, their reports' records for
 * managers, everything for admins), and the change is applied through the
 * normal edit server actions (see lib/ai/suggestions/appliers.ts), so stage
 * gates and permissions are the same as a manual edit.
 */

const id = z.uuid();
const note = z.string().max(500).nullish();

async function run(input: { id: string; action: 'accept' | 'reject' | 'edit'; value?: unknown; note?: string | null }): Promise<DecideResult> {
  if (!id.safeParse(input.id).success) return { ok: false, message: 'Invalid suggestion.' };
  if (!note.safeParse(input.note).success) return { ok: false, message: 'Note is too long.' };
  const out = await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    return await decideSuggestion({ tenantId: tenant.id, viewer: { userId, role: m.role }, ...input }, defaultAppliers);
  });
  revalidatePath('/dashboard/suggestions');
  revalidatePath('/dashboard/deals', 'layout');
  return out;
}

export async function acceptSuggestion(suggestionId: string, decisionNote?: string | null): Promise<DecideResult> {
  return run({ id: suggestionId, action: 'accept', note: decisionNote });
}

export async function rejectSuggestion(suggestionId: string, decisionNote?: string | null): Promise<DecideResult> {
  return run({ id: suggestionId, action: 'reject', note: decisionNote });
}

export async function editAndAcceptSuggestion(suggestionId: string, value: unknown, decisionNote?: string | null): Promise<DecideResult> {
  return run({ id: suggestionId, action: 'edit', value, note: decisionNote });
}

export type BulkResult = { accepted: number; rejected: number; failed: Array<{ id: string; message: string }> };

/** Bulk accept / reject. Each item goes through the same single-item path (and its checks). */
export async function bulkDecideSuggestions(ids: string[], action: 'accept' | 'reject'): Promise<BulkResult> {
  const unique = [...new Set(ids)].slice(0, 100);
  const out: BulkResult = { accepted: 0, rejected: 0, failed: [] };
  for (const sid of unique) {
    const r = await run({ id: sid, action });
    if (r.ok) out[r.status === 'accepted' ? 'accepted' : 'rejected']++;
    else out.failed.push({ id: sid, message: r.message });
  }
  return out;
}
