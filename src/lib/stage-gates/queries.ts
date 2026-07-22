import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { stageGates, type DealStage, type StageGate } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { GATE_RULE_META, type GateRuleType, type GateSeverity } from './types';

/** All gates for a tenant (active and inactive), stage- then rule-ordered. */
export async function listStageGates(tenantId: string): Promise<StageGate[]> {
  return tenantTransaction((tx) =>
    tx
      .select()
      .from(stageGates)
      .where(eq(stageGates.tenantId, tenantId))
      .orderBy(asc(stageGates.stage), asc(stageGates.ruleType)),
  );
}

export type UpsertStageGateInput = {
  tenantId: string;
  createdBy: string;
  stage: DealStage;
  ruleType: GateRuleType;
  ruleConfig: Record<string, unknown>;
  severity: GateSeverity;
  isActive?: boolean;
};

/**
 * Create or replace the single (tenant, stage, rule_type) gate. The unique
 * index makes "one rule of each type per stage" the invariant, so re-adding a
 * rule updates its config/severity in place rather than duplicating it.
 */
export async function upsertStageGate(
  input: UpsertStageGateInput,
): Promise<StageGate> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(stageGates)
      .values({
        tenantId: input.tenantId,
        stage: input.stage,
        ruleType: input.ruleType,
        ruleConfig: input.ruleConfig,
        severity: input.severity,
        isActive: input.isActive ?? true,
        createdBy: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [stageGates.tenantId, stageGates.stage, stageGates.ruleType],
        set: {
          ruleConfig: input.ruleConfig,
          severity: input.severity,
          isActive: input.isActive ?? true,
          updatedAt: new Date(),
        },
      })
      .returning(),
  );
  if (!row) throw new Error('stage_gate upsert failed');
  return row;
}

/** Flip a gate's active flag. Returns the updated row or null if not found. */
export async function setStageGateActive(
  tenantId: string,
  id: string,
  isActive: boolean,
): Promise<StageGate | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .update(stageGates)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(stageGates.id, id), eq(stageGates.tenantId, tenantId)))
      .returning(),
  );
  return row ?? null;
}

/** Permanently remove a gate rule. */
export async function deleteStageGate(
  tenantId: string,
  id: string,
): Promise<boolean> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .delete(stageGates)
      .where(and(eq(stageGates.id, id), eq(stageGates.tenantId, tenantId)))
      .returning({ id: stageGates.id }),
  );
  return Boolean(row);
}

/** Default config for a rule type — used to prefill the admin add-rule form. */
export function defaultConfigFor(ruleType: GateRuleType): Record<string, unknown> {
  return { ...GATE_RULE_META[ruleType].defaultConfig };
}
