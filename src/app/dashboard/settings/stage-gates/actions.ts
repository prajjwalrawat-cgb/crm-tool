'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import { DEAL_STAGES } from '@/lib/deals/schema';
import {
  deleteStageGate,
  setStageGateActive,
  upsertStageGate,
} from '@/lib/stage-gates/queries';
import {
  GATE_ACTIVITY_TYPES,
  GATE_RULE_TYPES,
  GATE_SEVERITIES,
  GATE_TASK_TYPES,
} from '@/lib/stage-gates/types';
import { setWorkspaceFlags } from '@/lib/workspace-settings/queries';

export type SettingsResult = { ok: true } | { ok: false; message: string };

/* -------- feature flag -------- */

export async function setStageGatesEnabledAction(
  enabled: boolean,
): Promise<SettingsResult> {
  const gate = await checkPermission('manageStageGates');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await setWorkspaceFlags(tenant.id, { stageGatesEnabled: Boolean(enabled) });
      revalidatePath('/dashboard/settings/stage-gates');
      revalidatePath('/dashboard/deals/board');
      return { ok: true };
    },
  );
}

/* -------- upsert a rule -------- */

// Per-rule-type config validation. Keeps the DB CHECK constraints honest and
// rejects malformed config before it can silently disable a gate.
const configSchema = z
  .object({
    fields: z.array(z.string().min(1)).optional(),
    count: z.number().int().min(0).optional(),
    types: z.array(z.enum(GATE_ACTIVITY_TYPES)).optional(),
    min: z.number().min(0).optional(),
    task_type: z.enum(GATE_TASK_TYPES).optional(),
    prompt: z.string().min(1).max(500).optional(),
  })
  .strip();

const upsertSchema = z.object({
  stage: z.enum(DEAL_STAGES),
  ruleType: z.enum(GATE_RULE_TYPES),
  severity: z.enum(GATE_SEVERITIES),
  config: configSchema,
});

function validateConfigForRule(
  ruleType: (typeof GATE_RULE_TYPES)[number],
  config: z.infer<typeof configSchema>,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  switch (ruleType) {
    case 'field_required':
      if (!config.fields || config.fields.length === 0)
        return { ok: false, message: 'Pick at least one required field.' };
      return { ok: true, value: { fields: config.fields } };
    case 'min_stakeholders':
      if (config.count == null || config.count < 1)
        return { ok: false, message: 'Stakeholder count must be ≥ 1.' };
      return { ok: true, value: { count: config.count } };
    case 'min_activities':
      if (config.count == null || config.count < 1)
        return { ok: false, message: 'Activity count must be ≥ 1.' };
      if (!config.types || config.types.length === 0)
        return { ok: false, message: 'Pick at least one activity type.' };
      return { ok: true, value: { count: config.count, types: config.types } };
    case 'amount_required':
      if (config.min == null || config.min < 0)
        return { ok: false, message: 'Minimum amount must be ≥ 0.' };
      return { ok: true, value: { min: config.min } };
    case 'task_complete':
      if (!config.task_type)
        return { ok: false, message: 'Pick a task type.' };
      return { ok: true, value: { task_type: config.task_type } };
    case 'custom_note':
      if (!config.prompt)
        return { ok: false, message: 'Enter a prompt for the rep.' };
      return { ok: true, value: { prompt: config.prompt } };
    default:
      return { ok: false, message: 'Unknown rule type.' };
  }
}

export async function upsertStageGateAction(
  input: unknown,
): Promise<SettingsResult> {
  const gate = await checkPermission('manageStageGates');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid rule.' };
  }
  if (parsed.data.stage === 'lead') {
    return { ok: false, message: 'Lead is the entry stage and cannot be gated.' };
  }
  const configResult = validateConfigForRule(
    parsed.data.ruleType,
    parsed.data.config,
  );
  if (!configResult.ok) return { ok: false, message: configResult.message };

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await upsertStageGate({
        tenantId: tenant.id,
        createdBy: membership.userId,
        stage: parsed.data.stage,
        ruleType: parsed.data.ruleType,
        ruleConfig: configResult.value,
        severity: parsed.data.severity,
      });
      revalidatePath('/dashboard/settings/stage-gates');
      revalidatePath('/dashboard/deals/board');
      return { ok: true };
    },
  );
}

/* -------- toggle / delete -------- */

const idSchema = z.object({ id: z.uuid() });

export async function toggleStageGateActiveAction(input: {
  id: string;
  isActive: boolean;
}): Promise<SettingsResult> {
  const gate = await checkPermission('manageStageGates');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;
  const parsed = idSchema.safeParse({ id: input.id });
  if (!parsed.success) return { ok: false, message: 'Invalid rule id.' };

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const row = await setStageGateActive(
        tenant.id,
        parsed.data.id,
        Boolean(input.isActive),
      );
      if (!row) return { ok: false, message: 'Rule not found.' };
      revalidatePath('/dashboard/settings/stage-gates');
      revalidatePath('/dashboard/deals/board');
      return { ok: true };
    },
  );
}

export async function deleteStageGateAction(id: string): Promise<SettingsResult> {
  const gate = await checkPermission('manageStageGates');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;
  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, message: 'Invalid rule id.' };

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const ok = await deleteStageGate(tenant.id, parsed.data.id);
      if (!ok) return { ok: false, message: 'Rule not found.' };
      revalidatePath('/dashboard/settings/stage-gates');
      revalidatePath('/dashboard/deals/board');
      return { ok: true };
    },
  );
}
