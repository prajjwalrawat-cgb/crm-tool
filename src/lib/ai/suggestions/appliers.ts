import 'server-only';

import { and, eq } from 'drizzle-orm';

import { updateDealStageAction, patchDealAction } from '@/app/dashboard/deals/actions';
import { updateDealFieldAction } from '@/app/dashboard/deals/[id]/actions';
import { patchContactAction } from '@/app/dashboard/contacts/actions';
import { createTaskAction } from '@/app/dashboard/tasks/actions';
import { calls, type FollowUpValue } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { ApplyResult, Appliers } from './service';

/**
 * The ONLY way an accepted suggestion reaches a deal or contact: the same
 * server actions a user's manual edit calls. They read the session (the
 * accepting user), check permissions, enforce stage gates / governance /
 * validation, and write the normal audit rows. Nothing here writes a deal or
 * contact column directly.
 */

const dealId = (s: { entityType: string; entityId: string }) => s.entityId;

function stageHint(r: Awaited<ReturnType<typeof updateDealStageAction>>): string {
  if (r.ok) return '';
  if (r.blocked) return `${r.message} Open the deal to complete the required steps.`;
  if (r.needsRollbackReason) return 'Moving this deal backwards needs a rollback reason. Make the change from the deal page.';
  if (r.needsCloseDate) return 'This stage needs a close date. Set it on the deal first.';
  if (r.needsCloseDateClear) return r.message;
  return r.message;
}

export const defaultAppliers: Appliers = {
  async stage({ suggestion, value }) {
    const stage = String(value);
    if (stage === 'lost' || stage === 'hold') {
      // Both need a reason the AI must not invent; send the user to the deal.
      return { ok: false, message: `Moving to ${stage} needs a reason. Make this change from the deal page.` };
    }
    const r = await updateDealStageAction({ id: dealId(suggestion), stage });
    return r.ok ? { ok: true } : { ok: false, message: stageHint(r) };
  },
  async amount({ suggestion, value }) {
    const r = await patchDealAction({ id: dealId(suggestion), amount: Number(value) });
    return r.ok ? { ok: true } : r;
  },
  async close_date({ suggestion, value }) {
    const r = await patchDealAction({
      id: dealId(suggestion),
      expectedCloseDate: String(value),
      closeDateChangeReason: `AI suggestion from ${suggestion.sourceType}, accepted by user`,
    });
    return r.ok ? { ok: true } : r;
  },
  async next_step({ suggestion, value }) {
    const r = await updateDealFieldAction({ dealId: dealId(suggestion), field: 'nextStep', value: String(value) });
    return r.ok ? { ok: true } : r;
  },
  async contact_name({ suggestion, value }) {
    const parts = String(value).trim().split(/\s+/);
    const firstName = parts.shift() ?? null;
    const lastName = parts.length ? parts.join(' ') : null;
    const r = await patchContactAction({ id: suggestion.entityId, firstName, lastName });
    return r.ok ? { ok: true } : r;
  },
  async contact_email({ suggestion, value }) {
    const r = await patchContactAction({ id: suggestion.entityId, email: String(value) });
    return r.ok ? { ok: true } : r;
  },
  async contact_phone({ suggestion, value }) {
    const r = await patchContactAction({ id: suggestion.entityId, phone: String(value) });
    return r.ok ? { ok: true } : r;
  },
  async contact_designation({ suggestion, value }) {
    const r = await patchContactAction({ id: suggestion.entityId, title: String(value) });
    return r.ok ? { ok: true } : r;
  },
  async follow_up_task({ tenantId, userId, suggestion, value }): Promise<ApplyResult> {
    const v = value as FollowUpValue;
    const fd = new FormData();
    fd.set('title', v.title);
    fd.set('dueDate', v.due_date);
    fd.set('type', 'followup');
    fd.set('status', 'todo');
    fd.set('priority', 'medium');
    fd.set('assignedUserId', suggestion.ownerId ?? userId);
    fd.set('entityType', suggestion.entityType === 'contact' ? 'contact' : 'deal');
    fd.set('entityId', suggestion.entityId);
    const r = await createTaskAction(fd);
    if (!r.ok) return { ok: false, message: r.message };
    if (suggestion.sourceType === 'call') {
      // Keep the call card's "follow-up added" state.
      await tenantTransaction((tx) =>
        tx.update(calls).set({ followUpTaskId: r.task.id }).where(and(eq(calls.id, suggestion.sourceId), eq(calls.tenantId, tenantId))),
      );
    }
    return { ok: true };
  },
};
