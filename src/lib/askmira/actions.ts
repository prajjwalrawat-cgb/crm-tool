import 'server-only';

// What AskMiraa's assistant does here for one person (act, use=act; each token once).
//
//   lead.save    a new lead from what they typed (company, contact, deal at
//                Lead, follow-up task, note), or changes to one (a new title, a
//                new number)
//   deal.stage   move a deal, with what the move needs (margin, close date,
//                Hold's reason and revisit date, why it was lost, why it goes back)
//   deal.decide  a manager approves or rejects a Won that waits on them
//   deal.note    a note on a deal
//
// Nothing here re-implements a rule. Each kind runs Saleinx's own server
// actions — createDealAction, updateDealStageAction, approveDealAction and the
// rest — as the person (runAsPerson), so their role, the margin and close-date
// rules, Hold's fields, stage gates and the manager approval of a rep's Won
// answer exactly as they would on the board. When one refuses, its own words
// go back to AskMiraa.

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';

import {
  createCompanyAction,
} from '@/app/dashboard/companies/actions';
import {
  createContactAction,
  patchContactAction,
} from '@/app/dashboard/contacts/actions';
import {
  approveDealAction,
  createDealAction,
  patchDealAction,
  rejectDealAction,
  updateDealStageAction,
} from '@/app/dashboard/deals/actions';
import { updateDealFieldAction } from '@/app/dashboard/deals/[id]/actions';
import { createNoteAction } from '@/app/dashboard/notes/actions';
import { createTaskAction } from '@/app/dashboard/tasks/actions';
import { deals } from '@/db/schema';
import { runAsPerson } from '@/lib/auth/acting-as';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { findCompanyMatches, findContactByEmail } from '@/lib/dedup/queries';
import { HOLD_REASON_LABELS, isHoldReason } from '@/lib/deals/hold';
import { DEAL_STAGE_LABELS, DEAL_STAGES, type DealStage } from '@/lib/deals/schema';
import { isRollbackReason, ROLLBACK_REASON_LABELS } from '@/lib/deals/stage-governance';
import { isOfferingsEnabled, listOfferingOptions } from '@/lib/offerings/queries';
import { can } from '@/lib/rbac';

import { clean, httpError, type Linked, type Person } from './core';
import { dealFor } from './queries';

export type ActArgs = { found: Linked; me: Person; params: Record<string, unknown> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function form(values: Record<string, string | null | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) data.set(key, value);
  }
  return data;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function day(value: unknown, what: string): string | null {
  const text = clean(value, 10);
  if (!text) return null;
  if (!DATE_RE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw httpError(422, `${what} must be a date like 2026-11-05.`);
  }
  return text;
}

/** A plain decimal amount in major units ("12000000", "71.10"); anything else is refused. */
function amountOf(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/,/g, '').trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) {
    throw httpError(422, `${what} must be a plain amount, like 12000000 or 71.10.`);
  }
  return text;
}

function percentOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/%/g, '').trim();
  const n = Number(text);
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || !(n > 0) || n > 100) {
    throw httpError(422, 'Margin must be a percentage above 0 and at most 100, like 32 or 32.5.');
  }
  return text;
}

function refuse(result: { ok: boolean; message?: string }, what: string): never {
  throw httpError(422, `${what}: ${result.message ?? 'Saleinx refused it.'}`);
}

function needsManage(me: Person) {
  if (!can(me.role, 'manageDeals')) {
    throw httpError(
      403,
      `You have view-only access in Saleinx (${me.role}), so you can't change deals there. ` +
        'Ask the deal’s owner or a sales manager.',
    );
  }
}

function asPerson<T>(me: Person, fn: () => Promise<T>) {
  return runAsPerson({ sub: me.userId, tid: me.tenantId }, fn);
}

function inScope<T>(me: Person, fn: () => Promise<T>) {
  return runWithTenantContext({ tenantId: me.tenantId, userId: me.userId }, fn);
}

function splitName(full: string | null, first: unknown, last: unknown) {
  const f = clean(first, 100);
  const l = clean(last, 100);
  if (f || l) return { first: f, last: l };
  if (!full) return { first: null, last: null };
  const parts = full.split(/\s+/);
  return { first: parts[0] ?? null, last: parts.slice(1).join(' ') || null };
}

/** Offering ids for the names (or ids) given; the workspace's own list decides. */
async function offeringIds(me: Person, wanted: unknown): Promise<string[]> {
  const names = (Array.isArray(wanted) ? wanted : [wanted])
    .map((w) => String(w ?? '').trim().toLowerCase())
    .filter(Boolean);
  const on = await inScope(me, () => isOfferingsEnabled(me.tenantId));
  if (!on) return [];
  const all = await inScope(me, () => listOfferingOptions(me.tenantId));
  const picked = all.filter(
    (o) => names.includes(o.id.toLowerCase()) || names.includes(o.name.toLowerCase()),
  );
  if (picked.length === 0) {
    throw httpError(
      422,
      'A new deal here must say what it sells. Which of these? ' +
        all.map((o) => o.name).join(', '),
    );
  }
  return picked.map((o) => o.id);
}

/* ── lead.save ─────────────────────────────────────────────── */

async function saveLead({ me, params }: ActArgs) {
  needsManage(me);
  const contact = obj(params.contact);
  const dealIn = obj(params.deal);
  const followUp = obj(params.follow_up);
  const note = clean(params.note, 8000);
  const contactEmail = clean(contact.email, 255)?.toLowerCase() ?? null;
  const contactPhone = clean(contact.phone, 50);
  const contactTitle = clean(contact.title, 100);
  const contactName = splitName(clean(contact.name, 200), contact.first_name, contact.last_name);
  const dueDate = day(followUp.due_date, 'The follow-up date');
  const amount = amountOf(dealIn.amount, 'The deal amount');
  const done: string[] = [];

  return await asPerson(me, async () => {
    let dealId = clean(params.deal_id, 40);
    let companyId: string | null = null;
    let contactId: string | null = null;

    if (dealId) {
      // An existing lead: its company and contact are the ones to change.
      const current = await dealFor(me, dealId);
      const [row] = await inScope(me, () =>
        tenantTransaction((tx) =>
          tx
            .select({ companyId: deals.companyId, contactId: deals.contactId })
            .from(deals)
            .where(and(eq(deals.id, current.id), eq(deals.tenantId, me.tenantId)))
            .limit(1),
        ),
      );
      companyId = row?.companyId ?? null;
      contactId = row?.contactId ?? null;
    } else {
      const companyName = clean(params.company, 200);
      const name = clean(dealIn.name, 200);
      if (!companyName || !name) {
        throw httpError(422, 'A new lead needs the company and a name for the deal.');
      }
      // The company: the one already here by that name, else a new one.
      const found = await inScope(me, () => findCompanyMatches(me.tenantId, companyName, 3));
      const exact = found.find((m) => m.kind === 'exact');
      if (exact) {
        companyId = exact.id;
      } else {
        const made = await createCompanyAction(form({ name: companyName }));
        if (!made.ok) refuse(made, 'The company could not be added');
        companyId = made.company.id;
        done.push(`company ${companyName} added`);
      }
      // The same open deal for this company already here (the same message sent twice).
      const [open] = await inScope(me, () =>
        tenantTransaction((tx) =>
          tx
            .select({ id: deals.id, contactId: deals.contactId })
            .from(deals)
            .where(
              and(
                eq(deals.tenantId, me.tenantId),
                eq(deals.companyId, companyId!),
                isNull(deals.deletedAt),
                notInArray(deals.stage, ['won', 'lost']),
                sql`lower(${deals.name}) = lower(${name})`,
              ),
            )
            .limit(1),
        ),
      );
      if (open) {
        dealId = open.id;
        contactId = open.contactId;
        done.push('found the lead already here, so nothing was added twice');
      }
    }

    // The contact: matched by email, else the deal's own, else a new one.
    if (contactEmail && !contactId) {
      const byEmail = await inScope(me, () => findContactByEmail(me.tenantId, contactEmail));
      if (byEmail) contactId = byEmail.id;
    }
    if (contactId) {
      const patch: Record<string, unknown> = { id: contactId };
      if (contactTitle) patch.title = contactTitle;
      if (contactPhone) patch.phone = contactPhone;
      if (contactEmail) patch.email = contactEmail;
      if (contactName.first) patch.firstName = contactName.first;
      if (contactName.last) patch.lastName = contactName.last;
      if (Object.keys(patch).length > 1) {
        const changed = await patchContactAction(patch);
        if (!changed.ok) refuse(changed, 'The contact could not be updated');
        done.push('contact updated');
      }
    } else if (contactName.first || contactEmail) {
      const made = await createContactAction(
        form({
          firstName: contactName.first,
          lastName: contactName.last,
          email: contactEmail,
          phone: contactPhone,
          title: contactTitle,
          companyId,
        }),
      );
      if (!made.ok) refuse(made, 'The contact could not be added');
      contactId = made.contact.id;
      done.push('contact added');
    }

    if (!dealId) {
      const ids = await offeringIds(me, dealIn.offerings);
      const made = await createDealAction(
        form({
          name: clean(dealIn.name, 200),
          description: clean(dealIn.description, 2000),
          // A lead carries no close date (Saleinx's rule): the decision date
          // goes in the next step instead.
          stage: 'lead',
          amount: amount ?? '0',
          currency: clean(dealIn.currency, 3)?.toUpperCase() ?? 'INR',
          companyId,
          contactId,
          ownerId: me.userId,
          offeringIds: ids.join(','),
          primaryOfferingId: ids[0] ?? null,
        }),
      );
      if (!made.ok) refuse(made, 'The lead could not be added');
      dealId = made.deal.id;
      done.push('lead added at Lead');
    } else {
      const patch: Record<string, unknown> = { id: dealId };
      if (amount) patch.amount = amount;
      if (contactId) patch.contactId = contactId;
      if (Object.keys(patch).length > 1) {
        const changed = await patchDealAction(patch);
        if (!changed.ok) refuse(changed, 'The lead could not be updated');
      }
    }

    for (const field of ['source', 'nextStep'] as const) {
      const value = clean(field === 'source' ? dealIn.source : dealIn.next_step, 500);
      if (!value) continue;
      const changed = await updateDealFieldAction({ dealId, field, value });
      if (!changed.ok) refuse(changed, `The ${field === 'source' ? 'source' : 'next step'} could not be saved`);
    }

    let taskId: string | null = null;
    if (clean(followUp.title, 280)) {
      const type = clean(followUp.type, 20) ?? 'followup';
      const made = await createTaskAction(
        form({
          title: clean(followUp.title, 280),
          description: clean(followUp.description, 4000),
          status: 'todo',
          priority: 'medium',
          type: ['call', 'email', 'meeting', 'internal', 'followup'].includes(type) ? type : 'followup',
          dueDate,
          assignedUserId: me.userId,
          entityType: 'deal',
          entityId: dealId,
        }),
      );
      if (!made.ok) refuse(made, 'The follow-up could not be added');
      taskId = made.task.id;
      done.push(`follow-up${dueDate ? ` on ${dueDate}` : ''}`);
    }

    if (note) {
      const made = await createNoteAction({ body: note, entityType: 'deal', entityId: dealId });
      if (!made.ok) refuse(made, 'The note could not be added');
      done.push('note added');
    }

    return { deal: await dealFor(me, dealId), task_id: taskId, done };
  });
}

/* ── deal.stage ────────────────────────────────────────────── */

async function moveDeal({ me, params }: ActArgs) {
  needsManage(me);
  const stage = String(params.stage ?? '').toLowerCase() as DealStage;
  if (!(DEAL_STAGES as readonly string[]).includes(stage)) {
    throw httpError(422, `Which stage? One of ${DEAL_STAGES.join(', ')}.`);
  }
  const margin = percentOf(params.margin_pct);
  const closeDate = day(params.expected_close_date, 'The expected close date');
  const revisit = day(params.hold_revisit_on, 'The revisit date');
  const holdReason = clean(params.hold_reason, 40);
  const rollbackReason = clean(params.rollback_reason, 40);
  if (stage === 'hold') {
    if (!holdReason || !isHoldReason(holdReason) || !revisit) {
      throw httpError(
        422,
        'Moving to Hold needs a reason (' +
          Object.values(HOLD_REASON_LABELS).join(', ') +
          ') and a date to revisit it.',
      );
    }
  }
  if (rollbackReason && !isRollbackReason(rollbackReason)) {
    throw httpError(422, `Why is it going back? One of ${Object.values(ROLLBACK_REASON_LABELS).join(', ')}.`);
  }

  return await asPerson(me, async () => {
    const before = await dealFor(me, params.deal_id);
    const done: string[] = [];
    if (margin || closeDate) {
      const changed = await patchDealAction({
        id: before.id,
        ...(margin ? { marginPct: margin } : {}),
        ...(closeDate ? { expectedCloseDate: closeDate } : {}),
      });
      if (!changed.ok) refuse(changed, 'The deal could not be updated');
      if (margin) done.push(`margin ${margin}%`);
      if (closeDate) done.push(`close date ${closeDate}`);
    }
    const nextStep = clean(params.next_step, 500);
    if (nextStep) {
      const changed = await updateDealFieldAction({ dealId: before.id, field: 'nextStep', value: nextStep });
      if (!changed.ok) refuse(changed, 'The next step could not be saved');
      done.push('next step');
    }

    const moved = await updateDealStageAction({
      id: before.id,
      stage,
      reason: clean(params.lost_reason, 1000) ?? undefined,
      holdReason: holdReason ?? undefined,
      holdRevisitOn: revisit ?? undefined,
      holdNote: clean(params.hold_note, 1000) ?? undefined,
      rollbackReason: rollbackReason ?? undefined,
      rollbackNote: clean(params.rollback_note, 1000) ?? undefined,
      clearCloseDate: params.clear_close_date === true ? true : undefined,
    });
    if (!moved.ok) {
      const label = DEAL_STAGE_LABELS[stage];
      let message = moved.message;
      if (moved.needsCloseDate) {
        message = `${label} needs an expected close date, and this deal has none. Say when it will close.`;
      } else if (moved.needsRollbackReason) {
        message =
          `Moving from ${before.stage_label} back to ${label} needs a reason: ` +
          Object.values(ROLLBACK_REASON_LABELS).join(', ') + '.';
      } else if (moved.needsCloseDateClear) {
        message = `${moved.message} Moving it to Lead clears its close date.`;
      } else if (moved.blocked && moved.failures?.length) {
        message = `${moved.message} ${moved.failures.map((f) => f.message).join(' ')}`;
      }
      const prefix = done.length ? `Saved ${done.join(', ')}, but the move was refused: ` : '';
      throw httpError(422, `${prefix}${message}`);
    }
    const after = await dealFor(me, before.id);
    return {
      deal: after,
      from: before.stage,
      changed: moved.changed,
      done,
      awaiting_approval: after.stage === 'won' && after.approval_status === 'pending',
    };
  });
}

/* ── deal.decide ───────────────────────────────────────────── */

async function decideDeal({ me, params }: ActArgs) {
  if (!can(me.role, 'approveDeals')) {
    throw httpError(403, 'Approving a won deal is for managers, admins and owners in Saleinx.');
  }
  const decision = String(params.decision ?? '');
  if (decision !== 'approve' && decision !== 'reject') {
    throw httpError(422, 'Approve or reject?');
  }
  return await asPerson(me, async () => {
    const before = await dealFor(me, params.deal_id);
    const result =
      decision === 'approve'
        ? await approveDealAction(before.id)
        : await rejectDealAction({ id: before.id, reason: clean(params.reason, 500) ?? undefined });
    if (!result.ok) refuse(result, 'Nothing was decided');
    return { deal: await dealFor(me, before.id), decision };
  });
}

/* ── deal.note ─────────────────────────────────────────────── */

async function noteDeal({ me, params }: ActArgs) {
  needsManage(me);
  const body = clean(params.body, 8000);
  if (!body) throw httpError(422, 'What should the note say?');
  return await asPerson(me, async () => {
    const deal = await dealFor(me, params.deal_id);
    const made = await createNoteAction({ body, entityType: 'deal', entityId: deal.id });
    if (!made.ok) refuse(made, 'The note could not be added');
    return { deal, note_id: made.note.id };
  });
}

export const ACTIONS: Record<string, (args: ActArgs) => Promise<Record<string, unknown>>> = {
  'lead.save': saveLead,
  'deal.stage': moveDeal,
  'deal.decide': decideDeal,
  'deal.note': noteDeal,
};
