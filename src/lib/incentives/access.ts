/**
 * Who may read an incentive plan. One rule, imported by every page, action
 * and route that returns plan or actuals data, so "a SPOC sees only their
 * own" cannot be true on one surface and false on another.
 *
 * Compensation is the most sensitive data in the CRM, so the default is
 * closed: you see your own plan, and the team's only with
 * `viewTeamIncentives` (manager tier and above — the same people who
 * already see every rep's targets). There is no reporting hierarchy in the
 * schema, so a manager sees the whole workspace, exactly as on Targets.
 *
 * Pure + client-safe.
 */
import type { MembershipRole } from '@/db/schema';
import { can } from '@/lib/rbac';

export type IncentiveViewer = { userId: string; role: MembershipRole | null | undefined };

export function canViewTeamIncentives(role: MembershipRole | null | undefined): boolean {
  return can(role, 'viewTeamIncentives');
}

export function canViewIncentivePlan(
  viewer: IncentiveViewer,
  plan: { userId: string },
): boolean {
  if (!viewer.role) return false;
  return plan.userId === viewer.userId || canViewTeamIncentives(viewer.role);
}

/**
 * Manual actuals may be entered by the plan's own SPOC or by an admin
 * (spec: "admin or SPOC enters"). Every entry records who made it, and the
 * calculator shows it, so a self-reported figure is never anonymous.
 */
export function canEnterManualActuals(
  viewer: IncentiveViewer,
  plan: { userId: string },
): boolean {
  if (!viewer.role) return false;
  return plan.userId === viewer.userId || can(viewer.role, 'manageIncentives');
}
