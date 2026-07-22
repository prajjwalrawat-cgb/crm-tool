import 'server-only';

import { recordActivity } from '@/lib/activity/recorder';
import type { DbExecutor } from '@/lib/db-context';
import type { DealStage } from '@/db/schema';

import {
  evaluateStageTransition,
  type DealGateOverride,
} from './evaluate';
import { STAGE_LABELS, type GateFailure, type GateResult } from './types';

export type { GateFailure, GateResult };

/**
 * Thrown inside a mutation transaction when a `block` gate fails, so the write
 * rolls back atomically. Caught just outside the transaction, where it's turned
 * into the structured `{ ok:false, blocked:true, failures }` action result.
 */
export class GateBlockedError extends Error {
  readonly failures: GateFailure[];
  readonly toStage: DealStage;
  constructor(toStage: DealStage, failures: GateFailure[]) {
    super(blockMessage(toStage, failures));
    this.name = 'GateBlockedError';
    this.failures = failures;
    this.toStage = toStage;
  }
}

/**
 * Evaluate + log warnings (via {@link checkGateAndLogWarnings}) and THROW
 * {@link GateBlockedError} when the move is blocked. Convenience for call sites
 * that prefer transaction-rollback semantics over threading a sentinel return.
 */
export async function enforceGateOrThrow(
  exec: DbExecutor,
  params: Parameters<typeof checkGateAndLogWarnings>[1],
): Promise<void> {
  const result = await checkGateAndLogWarnings(exec, params);
  if (!result.allowed) {
    throw new GateBlockedError(params.toStage, result.failures);
  }
}

/**
 * Human summary for a blocked transition — used as the action's `message` so a
 * caller that ignores the structured `failures` array still surfaces something
 * sensible (the slide-over renders the per-rule detail from `failures`).
 */
export function blockMessage(
  toStage: DealStage,
  failures: GateFailure[],
): string {
  const blockers = failures.filter((f) => f.severity === 'block');
  const n = blockers.length;
  return `Can't move to ${STAGE_LABELS[toStage]}: ${n} requirement${n === 1 ? '' : 's'} not met.`;
}

/**
 * Evaluate the gate and, when the move is allowed but `warn` rules failed,
 * append a single `gate_warning` activity row (in the caller's transaction).
 * Returns the full result so the caller can reject on `!allowed`.
 */
export async function checkGateAndLogWarnings(
  exec: DbExecutor,
  params: {
    tenantId: string;
    actorUserId: string;
    dealId: string | null;
    dealName: string;
    fromStage: DealStage | null;
    toStage: DealStage;
    override?: DealGateOverride;
    gateNote?: string;
  },
): Promise<GateResult> {
  const result = await evaluateStageTransition(exec, {
    tenantId: params.tenantId,
    dealId: params.dealId,
    fromStage: params.fromStage,
    toStage: params.toStage,
    override: params.override,
    gateNote: params.gateNote,
  });

  if (result.allowed) {
    const warns = result.failures.filter((f) => f.severity === 'warn');
    // Only log warnings once the deal actually exists (dealId present). For a
    // create, the deal id isn't known until after insert — the caller logs
    // post-insert instead (see createDealAction).
    if (warns.length > 0 && params.dealId) {
      await recordActivity(exec, {
        tenantId: params.tenantId,
        actorUserId: params.actorUserId,
        entityType: 'deal',
        entityId: params.dealId,
        action: 'gate_warning',
        metadata: {
          name: params.dealName,
          from: params.fromStage,
          to: params.toStage,
          rules: warns.map((w) => ({
            rule_type: w.rule_type,
            message: w.message,
          })),
        },
      });
    }
  }

  return result;
}
