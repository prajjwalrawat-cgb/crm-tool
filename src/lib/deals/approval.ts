import type { MembershipRole } from '@/db/schema';
import { canApproveDeals } from '@/lib/rbac';

import type { DealStage } from './schema';

/**
 * Margin is stored as basis points (integer) to avoid float drift, the same
 * way money is stored in minor units. 30% ⇢ 3000 bps.
 */
export function marginPctToBps(pct: number): number {
  return Math.round(pct * 100);
}

export function marginBpsToPct(bps: number): number {
  return bps / 100;
}

/** Margin value in minor units for a deal: amount × margin%. */
export function marginMinor(
  amountMinor: number,
  marginBps: number | null | undefined,
): number {
  if (!marginBps) return 0;
  return Math.round((amountMinor * marginBps) / 10_000);
}

export type ApprovalPatch = {
  approvalStatus: 'none' | 'pending' | 'approved' | 'rejected';
  approvedBy: string | null;
  approvedAt: Date | null;
};

/**
 * Approval state a deal should carry when it FIRST enters the Won stage.
 * A manager/admin/owner moving it to Won is itself the approval (auto-
 * approved); a plain member's Won sits 'pending' until a manager approves.
 * Callers use this only on the transition into Won — staying at Won or
 * leaving it is handled separately so an unrelated edit never resets an
 * existing approval.
 */
export function approvalOnEnterWon(
  actorRole: MembershipRole | null | undefined,
  actorUserId: string,
  now: Date,
): ApprovalPatch {
  if (canApproveDeals(actorRole)) {
    return {
      approvalStatus: 'approved',
      approvedBy: actorUserId,
      approvedAt: now,
    };
  }
  return { approvalStatus: 'pending', approvedBy: null, approvedAt: null };
}

const CLEARED: ApprovalPatch = {
  approvalStatus: 'none',
  approvedBy: null,
  approvedAt: null,
};

/**
 * Approval patch for a stage transition. Returns `null` when the approval
 * fields should be left UNTOUCHED (deal stays at Won — don't disturb an
 * existing approval on an unrelated edit).
 */
export function approvalForTransition(
  previousStage: DealStage,
  nextStage: DealStage,
  actorRole: MembershipRole | null | undefined,
  actorUserId: string,
  now: Date,
): ApprovalPatch | null {
  const wasWon = previousStage === 'won';
  const nowWon = nextStage === 'won';
  if (nowWon && !wasWon) {
    return approvalOnEnterWon(actorRole, actorUserId, now);
  }
  if (!nowWon) return CLEARED;
  return null; // stays Won → leave approval as-is
}
