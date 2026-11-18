'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import {
  createCaptureForm,
  createDistributionRule,
  createLeadSource,
  deleteCaptureForm,
  deleteDistributionRule,
  DuplicateFormSlugError,
  listIngestEvents,
  reorderDistributionRules,
  rotateLeadSourceSecret,
  setCaptureFormPublished,
  setLeadSourceActive,
  setUserAvailability,
  updateCaptureForm,
  updateDistributionRule,
  updateLeadSource,
  upsertRoutingProfile,
  type IngestEventListItem,
} from '@/lib/lead-capture/admin';
import { simulateDistribution, type DistributionPlan } from '@/lib/lead-capture/distribute';
import { receiveIngestEvent, resetIngestEventForRetry } from '@/lib/lead-capture/ingest';
import {
  captureFormInputSchema,
  distributionRuleInputSchema,
  leadSourceInputSchema,
  routingProfileInputSchema,
  simulateInputSchema,
} from '@/lib/lead-capture/validation';

/**
 * Server actions for Settings › Lead sources / Forms / Distribution. All are
 * gated on `manageLeadCapture` (owner + admin) except the personal
 * availability toggle, which any member may flip for themselves.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; message: string };

const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return i ? `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` : 'Invalid input';
};

async function asAdmin<T>(fn: (ctx: { tenantId: string; userId: string }) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  const gate = await checkPermission('manageLeadCapture');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;
  try {
    return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () =>
      fn({ tenantId: tenant.id, userId: membership.userId }),
    );
  } catch (err) {
    if (err instanceof DuplicateFormSlugError) return { ok: false, message: err.message };
    throw err;
  }
}

const idSchema = z.string().uuid();

function revalidateSettings() {
  revalidatePath('/dashboard/settings/lead-sources');
  revalidatePath('/dashboard/settings/lead-forms');
  revalidatePath('/dashboard/settings/distribution');
}

/* ------------------------------------------------------------------ sources */

export async function createLeadSourceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = leadSourceInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId, userId }) => {
    const id = await createLeadSource(tenantId, userId, parsed.data);
    revalidateSettings();
    return { ok: true, data: { id } };
  });
}

export async function updateLeadSourceAction(id: string, input: unknown): Promise<ActionResult> {
  const parsed = leadSourceInputSchema.safeParse(input);
  if (!parsed.success || !idSchema.safeParse(id).success) return { ok: false, message: parsed.success ? 'Invalid source' : firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId }) => {
    if (!(await updateLeadSource(tenantId, id, parsed.data))) return { ok: false, message: 'Source not found' };
    revalidateSettings();
    return { ok: true };
  });
}

export async function rotateLeadSourceSecretAction(id: string): Promise<ActionResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid source' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await rotateLeadSourceSecret(tenantId, id))) return { ok: false, message: 'Source not found' };
    revalidateSettings();
    return { ok: true };
  });
}

export async function setLeadSourceActiveAction(id: string, active: boolean): Promise<ActionResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid source' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await setLeadSourceActive(tenantId, id, Boolean(active)))) return { ok: false, message: 'Source not found' };
    revalidateSettings();
    return { ok: true };
  });
}

/** Push a sample lead through the real ingest pipeline (no HTTP). */
export async function sendTestLeadAction(id: string): Promise<ActionResult<{ eventId: string }>> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid source' };
  return asAdmin(async ({ tenantId }) => {
    const stamp = Date.now().toString().slice(-6);
    const payload = {
      name: `Test Lead ${stamp}`,
      email: `test-lead-${stamp}@example.com`,
      phone: `+9190000${stamp.slice(-5)}`,
      company: 'Saleinx Test Co',
      city: 'Pune',
      state: 'Maharashtra',
      product: 'Test enquiry',
      message: 'Sent from Settings › Lead sources › Send test lead.',
      utm_source: 'saleinx_test',
    };
    const { eventId } = await receiveIngestEvent({ tenantId, sourceId: id, payload });
    await sendWorkflowEvent('crm/lead.ingest_received', { tenantId, eventId });
    revalidateSettings();
    return { ok: true, data: { eventId } };
  });
}

export async function listIngestEventsAction(opts: { sourceId?: string; status?: 'received' | 'processed' | 'duplicate' | 'failed' }): Promise<ActionResult<IngestEventListItem[]>> {
  return asAdmin(async ({ tenantId }) => ({ ok: true, data: await listIngestEvents(tenantId, { ...opts, limit: 50 }) }));
}

export async function retryIngestEventAction(eventId: string): Promise<ActionResult> {
  if (!idSchema.safeParse(eventId).success) return { ok: false, message: 'Invalid event' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await resetIngestEventForRetry(eventId))) return { ok: false, message: 'Only failed events can be retried' };
    await sendWorkflowEvent('crm/lead.ingest_received', { tenantId, eventId });
    revalidateSettings();
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ forms */

export async function saveCaptureFormAction(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = captureFormInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId }) => {
    if (id) {
      if (!idSchema.safeParse(id).success || !(await updateCaptureForm(tenantId, id, parsed.data))) {
        return { ok: false, message: 'Form not found' };
      }
      revalidateSettings();
      return { ok: true, data: { id } };
    }
    const newId = await createCaptureForm(tenantId, parsed.data);
    revalidateSettings();
    return { ok: true, data: { id: newId } };
  });
}

export async function setCaptureFormPublishedAction(id: string, published: boolean): Promise<ActionResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid form' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await setCaptureFormPublished(tenantId, id, Boolean(published)))) return { ok: false, message: 'Form not found' };
    revalidateSettings();
    return { ok: true };
  });
}

export async function deleteCaptureFormAction(id: string): Promise<ActionResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid form' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await deleteCaptureForm(tenantId, id))) return { ok: false, message: 'Form not found' };
    revalidateSettings();
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ rules */

export async function saveDistributionRuleAction(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = distributionRuleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId }) => {
    if (id) {
      if (!idSchema.safeParse(id).success || !(await updateDistributionRule(tenantId, id, parsed.data))) {
        return { ok: false, message: 'Rule not found' };
      }
      revalidateSettings();
      return { ok: true, data: { id } };
    }
    const newId = await createDistributionRule(tenantId, parsed.data);
    revalidateSettings();
    return { ok: true, data: { id: newId } };
  });
}

export async function deleteDistributionRuleAction(id: string): Promise<ActionResult> {
  if (!idSchema.safeParse(id).success) return { ok: false, message: 'Invalid rule' };
  return asAdmin(async ({ tenantId }) => {
    if (!(await deleteDistributionRule(tenantId, id))) return { ok: false, message: 'Rule not found' };
    revalidateSettings();
    return { ok: true };
  });
}

export async function reorderDistributionRulesAction(orderedIds: string[]): Promise<ActionResult> {
  const parsed = z.array(idSchema).max(500).safeParse(orderedIds);
  if (!parsed.success) return { ok: false, message: 'Invalid order' };
  return asAdmin(async ({ tenantId }) => {
    await reorderDistributionRules(tenantId, parsed.data);
    revalidateSettings();
    return { ok: true };
  });
}

export type SimulationView = {
  kind: DistributionPlan['kind'];
  ruleName: string | null;
  userId: string | null;
  reason: string;
  retryAt: string | null;
  eligibility: Array<{ userId: string; eligible: boolean; blockedBy: string | null; load: number; untouchedOpen: number }>;
};

export async function simulateDistributionAction(input: unknown): Promise<ActionResult<SimulationView>> {
  const parsed = simulateInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId }) => {
    const plan = await simulateDistribution({ tenantId, sample: parsed.data });
    return {
      ok: true,
      data: {
        kind: plan.kind,
        ruleName: plan.rule?.name ?? null,
        userId: plan.kind === 'assign' ? plan.userId : null,
        reason: plan.reason,
        retryAt: plan.kind === 'assign' || !plan.retryAt ? null : plan.retryAt.toISOString(),
        eligibility: plan.eligibility,
      },
    };
  });
}

/* ------------------------------------------------------------------ routing profiles */

export async function saveRoutingProfileAction(input: unknown): Promise<ActionResult> {
  const parsed = routingProfileInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  return asAdmin(async ({ tenantId }) => {
    await upsertRoutingProfile(tenantId, parsed.data);
    revalidatePath('/dashboard/settings/distribution');
    return { ok: true };
  });
}

/** Any member: mark yourself available / unavailable for new leads. */
export async function setMyAvailabilityAction(available: boolean): Promise<ActionResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;
  await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () =>
    setUserAvailability(tenant.id, membership.userId, Boolean(available)),
  );
  revalidatePath('/dashboard/settings/distribution');
  return { ok: true };
}
