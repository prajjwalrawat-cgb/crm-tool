import { pgEnum } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', [
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
]);

export const membershipStatus = pgEnum('membership_status', [
  'active',
  'invited',
  'suspended',
]);

export const dealStage = pgEnum('deal_stage', [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'hold',
  'won',
  'lost',
]);

export const dealApprovalStatus = pgEnum('deal_approval_status', [
  'none',
  'pending',
  'approved',
  'rejected',
]);

export const taskStatus = pgEnum('task_status', [
  'todo',
  'in_progress',
  'completed',
  'cancelled',
]);

export const taskPriority = pgEnum('task_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);

export type DealApprovalStatus = (typeof dealApprovalStatus.enumValues)[number];
export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type MembershipStatus = (typeof membershipStatus.enumValues)[number];
export type DealStage = (typeof dealStage.enumValues)[number];
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskPriority = (typeof taskPriority.enumValues)[number];
