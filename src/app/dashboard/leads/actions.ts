'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { getImportJob, getLeadSource, listUnassignedLeadIds } from '@/lib/lead-capture/admin';
import {
  buildImportPreview,
  createImportJob,
  ensureCsvImportSource,
  IMPORT_MAX_BYTES,
  previewRows,
  type ImportColumnMapping,
  type ImportPreview,
} from '@/lib/lead-capture/import';
import { parseCsv } from '@/lib/lead-capture/csv';
import { LEAD_FIELD_KEYS } from '@/lib/lead-capture/mapping';
import { reassignLead } from '@/lib/lead-capture/sla';

/**
 * Leads: unassigned-queue assignment, single reassign, and CSV import.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; message: string };

const assignSchema = z.object({
  dealIds: z.array(z.string().uuid()).max(5000).optional(),
  /** "Select all matching": assign every lead matching this queue filter. */
  filter: z.object({ sourceId: z.string().uuid().optional(), q: z.string().max(200).optional(), state: z.string().max(120).optional() }).optional(),
  to: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).nullable().default(null),
});

export async function assignLeadsAction(input: unknown): Promise<ActionResult<{ assigned: number; failed: number }>> {
  const gate = await checkPermission('assignLeads');
  if (!gate.ok) return { ok: false, message: gate.message };
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Pick leads and a person to assign them to.' };
  const { tenant, membership } = gate;
  return runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async () => {
    const ids = parsed.data.filter
      ? await listUnassignedLeadIds(tenant.id, parsed.data.filter)
      : (parsed.data.dealIds ?? []);
    let assigned = 0;
    let failed = 0;
    for (const dealId of ids) {
      const r = await reassignLead({
        tenantId: tenant.id,
        dealId,
        toUserId: parsed.data.to,
        actorUserId: membership.userId,
        reason: parsed.data.reason ?? 'Assigned from the unassigned queue',
      });
      if (r.ok) assigned++;
      else failed++;
    }
    revalidatePath('/dashboard/leads/unassigned');
    revalidatePath('/dashboard/deals');
    return { ok: true, data: { assigned, failed } };
  });
}

export async function reassignLeadAction(dealId: string, to: string, reason: string | null): Promise<ActionResult> {
  const gate = await checkPermission('assignLeads');
  if (!gate.ok) return { ok: false, message: gate.message };
  if (!z.string().uuid().safeParse(dealId).success || !to) return { ok: false, message: 'Invalid lead or user' };
  const { tenant, membership } = gate;
  const r = await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () =>
    reassignLead({ tenantId: tenant.id, dealId, toUserId: to, actorUserId: membership.userId, reason: reason?.slice(0, 500) ?? null }),
  );
  if (!r.ok) return { ok: false, message: r.error };
  revalidatePath(`/dashboard/deals/${dealId}`);
  revalidatePath('/dashboard/leads/unassigned');
  return { ok: true };
}

/* ------------------------------------------------------------------ CSV import */

const mappingSchema = z.record(z.string().max(300), z.enum(LEAD_FIELD_KEYS).nullable());

export async function previewImportAction(csvText: string): Promise<ActionResult<ImportPreview>> {
  const gate = await checkPermission('importLeads');
  if (!gate.ok) return { ok: false, message: gate.message };
  if (typeof csvText !== 'string' || csvText.length === 0) return { ok: false, message: 'The file is empty.' };
  if (csvText.length > IMPORT_MAX_BYTES) return { ok: false, message: 'The file is larger than 4 MB. Split it and import in parts.' };
  const preview = await buildImportPreview(csvText);
  if (preview.headers.length === 0) return { ok: false, message: 'No header row found.' };
  return { ok: true, data: preview };
}

/** Re-validate the preview rows after the user edits the mapping (no AI call). */
export async function revalidateImportPreviewAction(csvText: string, mapping: ImportColumnMapping): Promise<ActionResult<ImportPreview['rows']>> {
  const gate = await checkPermission('importLeads');
  if (!gate.ok) return { ok: false, message: gate.message };
  const m = mappingSchema.safeParse(mapping);
  if (!m.success || typeof csvText !== 'string' || csvText.length > 256 * 1024) return { ok: false, message: 'Invalid preview' };
  return { ok: true, data: previewRows(parseCsv(csvText, 50).rows, m.data) };
}

export async function commitImportAction(input: {
  csvText: string;
  fileName: string | null;
  mapping: ImportColumnMapping;
  sourceId: string | null;
}): Promise<ActionResult<{ jobId: string; total: number }>> {
  const gate = await checkPermission('importLeads');
  if (!gate.ok) return { ok: false, message: gate.message };
  const m = mappingSchema.safeParse(input.mapping);
  if (!m.success) return { ok: false, message: 'Invalid mapping' };
  if (!Object.values(m.data).some((v) => v === 'phone' || v === 'email')) {
    return { ok: false, message: 'Map at least one column to Phone or Email.' };
  }
  if (input.csvText.length > IMPORT_MAX_BYTES) return { ok: false, message: 'The file is larger than 4 MB.' };
  const { tenant, membership } = gate;
  return runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, async () => {
    let sourceId = input.sourceId;
    if (sourceId) {
      if (!z.string().uuid().safeParse(sourceId).success || !(await getLeadSource(tenant.id, sourceId))) {
        return { ok: false, message: 'Pick a valid lead source.' };
      }
    } else {
      sourceId = await ensureCsvImportSource(tenant.id, membership.userId);
    }
    const job = await createImportJob({
      tenantId: tenant.id,
      createdBy: membership.userId,
      sourceId,
      fileName: input.fileName?.slice(0, 200) ?? null,
      csvText: input.csvText,
      mapping: m.data,
    });
    if (job.total === 0) return { ok: false, message: 'No rows to import with this mapping.' };
    await sendWorkflowEvent('crm/lead.import_requested', { tenantId: tenant.id, jobId: job.jobId });
    return { ok: true, data: job };
  });
}

export async function getImportJobAction(jobId: string) {
  const gate = await checkPermission('importLeads');
  if (!gate.ok) return { ok: false as const, message: gate.message };
  if (!z.string().uuid().safeParse(jobId).success) return { ok: false as const, message: 'Invalid job' };
  const { tenant, membership } = gate;
  const job = await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () => getImportJob(tenant.id, jobId));
  if (!job) return { ok: false as const, message: 'Job not found' };
  return { ok: true as const, data: { ...job, createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null } };
}
