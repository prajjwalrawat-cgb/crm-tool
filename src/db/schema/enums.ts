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

export const taskType = pgEnum('task_type', [
  'call',
  'email',
  'meeting',
  'internal',
  'followup',
]);

export const taskRecurrence = pgEnum('task_recurrence', [
  'daily',
  'weekly',
  'custom',
]);

export const dealContactRole = pgEnum('deal_contact_role', [
  'decision_maker',
  'influencer',
  'champion',
  'blocker',
  'other',
]);

export const dealDocumentCategory = pgEnum('deal_document_category', [
  'proposal',
  'contract',
  'pricing',
  'other',
]);

export type DealApprovalStatus = (typeof dealApprovalStatus.enumValues)[number];
export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type MembershipStatus = (typeof membershipStatus.enumValues)[number];
export type DealStage = (typeof dealStage.enumValues)[number];
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskPriority = (typeof taskPriority.enumValues)[number];
export type TaskType = (typeof taskType.enumValues)[number];
export type TaskRecurrence = (typeof taskRecurrence.enumValues)[number];
export type DealContactRole = (typeof dealContactRole.enumValues)[number];
export type DealDocumentCategory =
  (typeof dealDocumentCategory.enumValues)[number];
