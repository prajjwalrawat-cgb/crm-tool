import { Inngest, eventType, staticSchema } from 'inngest';

import type { WorkflowEvents } from './events';

/**
 * Singleton Inngest client. The `id` is the app identifier — same string
 * is registered with Inngest cloud / dev for routing.
 *
 * Inngest v4 changed how schemas are wired: instead of binding a record
 * type at construction (`EventSchemas`), each event is declared with
 * `eventType('name', { schema })` and used as a trigger on the receiving
 * function. We keep our own `WorkflowEvents` map for the *send* side and
 * cast through it in `sendWorkflowEvent` — Inngest's send signature itself
 * is structurally permissive in v4.
 */
export const inngest = new Inngest({
  id: 'multi-tenant-crm',
});

/* -------- Event registry — typed triggers reused by every workflow -------- */

export const dealCreatedEvent = eventType('crm/deal.created', {
  schema: staticSchema<WorkflowEvents['crm/deal.created']>(),
});

export const dealStageChangedEvent = eventType('crm/deal.stage_changed', {
  schema: staticSchema<WorkflowEvents['crm/deal.stage_changed']>(),
});

export const contactCreatedEvent = eventType('crm/contact.created', {
  schema: staticSchema<WorkflowEvents['crm/contact.created']>(),
});

export const companyCreatedEvent = eventType('crm/company.created', {
  schema: staticSchema<WorkflowEvents['crm/company.created']>(),
});

export const memberInvitedEvent = eventType('crm/member.invited', {
  schema: staticSchema<WorkflowEvents['crm/member.invited']>(),
});

export const embedEntityEvent = eventType('crm/ai.embed_entity', {
  schema: staticSchema<WorkflowEvents['crm/ai.embed_entity']>(),
});

export const dealHealthRecomputeEvent = eventType('crm/deal.health_recompute', {
  schema: staticSchema<WorkflowEvents['crm/deal.health_recompute']>(),
});

/* -------- Lead capture (0072) -------- */

export const leadIngestReceivedEvent = eventType('crm/lead.ingest_received', {
  schema: staticSchema<WorkflowEvents['crm/lead.ingest_received']>(),
});

export const leadCreatedEvent = eventType('crm/lead.created', {
  schema: staticSchema<WorkflowEvents['crm/lead.created']>(),
});

export const leadReassignRequestedEvent = eventType('crm/lead.reassign_requested', {
  schema: staticSchema<WorkflowEvents['crm/lead.reassign_requested']>(),
});

export const leadImportRequestedEvent = eventType('crm/lead.import_requested', {
  schema: staticSchema<WorkflowEvents['crm/lead.import_requested']>(),
});

/* -------- Telephony (0073) -------- */

export const callEventReceivedEvent = eventType('crm/call.event_received', {
  schema: staticSchema<WorkflowEvents['crm/call.event_received']>(),
});

export const callCompletedEvent = eventType('crm/call.completed', {
  schema: staticSchema<WorkflowEvents['crm/call.completed']>(),
});

export const callRecordingArchivedEvent = eventType('crm/call.recording_archived', {
  schema: staticSchema<WorkflowEvents['crm/call.recording_archived']>(),
});

export const callTranscribeRequestedEvent = eventType('crm/call.transcribe_requested', {
  schema: staticSchema<WorkflowEvents['crm/call.transcribe_requested']>(),
});

export const callTranscribedEvent = eventType('crm/call.transcribed', {
  schema: staticSchema<WorkflowEvents['crm/call.transcribed']>(),
});

export const callSummarizedEvent = eventType('crm/call.summarized', {
  schema: staticSchema<WorkflowEvents['crm/call.summarized']>(),
});

export const emailThreadSummarizedEvent = eventType('crm/email.thread_summarized', {
  schema: staticSchema<WorkflowEvents['crm/email.thread_summarized']>(),
});

/* -------- Reports (0074) -------- */

export const reportBackfillRequestedEvent = eventType('crm/report.backfill_requested', {
  schema: staticSchema<WorkflowEvents['crm/report.backfill_requested']>(),
});

/* -------- Prospect Board (0079) -------- */

export const prospectCreatedEvent = eventType('crm/prospect.created', {
  schema: staticSchema<WorkflowEvents['crm/prospect.created']>(),
});
