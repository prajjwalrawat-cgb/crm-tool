import { pgEnum } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', [
  'owner',
  'admin',
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
  'won',
  'lost',
]);

export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type MembershipStatus = (typeof membershipStatus.enumValues)[number];
export type DealStage = (typeof dealStage.enumValues)[number];
