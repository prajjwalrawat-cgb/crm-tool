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

export const dealType = pgEnum('deal_type', [
  'new_logo',
  'renewal',
  'expansion',
  'upsell',
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

/**
 * Commercial elements a contract value can be made of. `other` carries a
 * free-text label (`deal_value_splits.component_label`) so a one-off line
 * doesn't need an enum change.
 */
export const dealValueComponent = pgEnum('deal_value_component', [
  'license',
  'implementation',
  'support',
  'amc',
  'training',
  'hardware',
  'other',
]);

/**
 * How an element is charged. Drives the year auto-fill (one-time → year 1,
 * recurring → spread across the term); it records intent and is not a
 * constraint, since any cell stays editable afterwards.
 */
export const dealValueBillingType = pgEnum('deal_value_billing_type', [
  'one_time',
  'recurring',
]);

/**
 * What an offering IS (0066). Two values, not a longer taxonomy: the split
 * that changes how the business behaves is Product vs Service — different
 * margins, different delivery, different people. Anything finer belongs in
 * the `offerings` catalog rows themselves, which an admin can edit.
 */
export const offeringCategory = pgEnum('offering_category', [
  'product',
  'service',
]);

export const dealDocumentCategory = pgEnum('deal_document_category', [
  'proposal',
  'contract',
  'pricing',
  'other',
  // 0071 — the client's order confirmation; see deal_order_proofs.
  'purchase_order',
]);

export const quoteStatus = pgEnum('quote_status', ['draft', 'sent', 'superseded']);

export type DealApprovalStatus = (typeof dealApprovalStatus.enumValues)[number];
export type DealTypeEnum = (typeof dealType.enumValues)[number];
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
export type OfferingCategory = (typeof offeringCategory.enumValues)[number];
export type QuoteStatus = (typeof quoteStatus.enumValues)[number];

// Field Meetings (0081)
export const meetingType = pgEnum('meeting_type', ['physical', 'virtual']);
export const meetingStatus = pgEnum('meeting_status', [
  'planned',
  'en_route',
  'arrived',
  'checked_in',
  'checked_out',
  'mom_logged',
  'cancelled',
]);
export const meetingSource = pgEnum('meeting_source', [
  'manual',
  'gcal',
  'outlook',
  'walk_in',
]);
export const geocodeStatus = pgEnum('geocode_status', [
  'pending',
  'ok',
  'failed',
  'manual',
]);
/** 'verify': a later attempt to verify an unverified visit (never a check-in). */
export const checkinKind = pgEnum('checkin_kind', ['in', 'out', 'verify']);
export const locationSource = pgEnum('location_source', [
  'askmira',
  'native',
  'browser',
]);
export const meetingSentiment = pgEnum('meeting_sentiment', [
  'positive',
  'neutral',
  'negative',
]);
export const calendarProvider = pgEnum('calendar_provider', [
  'google',
  'microsoft',
]);
export const locationProvider = pgEnum('location_provider', [
  'askmira',
  'native',
  'none',
]);
export const identityMatchMethod = pgEnum('identity_match_method', [
  'sso',
  'email',
  'manual',
]);

export type MeetingType = (typeof meetingType.enumValues)[number];
export type MeetingStatus = (typeof meetingStatus.enumValues)[number];
export type MeetingSource = (typeof meetingSource.enumValues)[number];
export type GeocodeStatus = (typeof geocodeStatus.enumValues)[number];
export type CheckinKind = (typeof checkinKind.enumValues)[number];
export type LocationSource = (typeof locationSource.enumValues)[number];
export type MeetingSentiment = (typeof meetingSentiment.enumValues)[number];
export type CalendarProvider = (typeof calendarProvider.enumValues)[number];
export type LocationProvider = (typeof locationProvider.enumValues)[number];
export type IdentityMatchMethod =
  (typeof identityMatchMethod.enumValues)[number];
