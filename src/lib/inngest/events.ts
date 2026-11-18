import type { EmbeddedEntityType } from '@/db/schema';
import type { DealStage } from '@/lib/deals/schema';

/**
 * Inngest event registry.
 *
 * Each entry is the raw `data` shape — Inngest's `eventType` + `staticSchema`
 * wrap it under `event.data` automatically when the function executes.
 *
 * The shape is intentionally narrower than the realtime payload — workflows
 * mostly need ids + tenant scope, not full row dumps. Extra context (e.g.
 * deal name) is included where it saves the workflow a follow-up DB read.
 */
export type WorkflowEvents = {
  'crm/deal.created': {
    tenantId: string;
    dealId: string;
    actorUserId: string | null;
    name: string;
    stage: DealStage;
  };
  'crm/deal.stage_changed': {
    tenantId: string;
    dealId: string;
    actorUserId: string | null;
    from: DealStage;
    to: DealStage;
    name: string;
  };
  'crm/contact.created': {
    tenantId: string;
    contactId: string;
    actorUserId: string | null;
    displayName: string;
  };
  'crm/company.created': {
    tenantId: string;
    companyId: string;
    actorUserId: string | null;
    name: string;
  };
  'crm/member.invited': {
    tenantId: string;
    email: string;
    role: 'admin' | 'manager' | 'member';
    invitationId: string;
    inviterUserId: string;
  };
  /**
   * Fan-in event for the embedding regeneration workflow. Emitted from any
   * mutation that changes the embeddable text of a deal/company/contact —
   * the workflow rebuilds the source text inside the worker (so it picks
   * up any joins the action didn't bother carrying), hashes, and decides
   * whether to call OpenAI.
   */
  'crm/ai.embed_entity': {
    tenantId: string;
    entityType: EmbeddedEntityType;
    entityId: string;
    actorUserId: string | null;
    /** Free-form reason — surfaced on the workflow run row. */
    reason: 'created' | 'updated' | 'restored' | 'manual';
  };
  /**
   * Fan-in event for the deal health-score recompute (Module 2). Emitted from
   * any mutation that changes a scoring signal — activity logged, stage
   * changed, task created/completed, stakeholder added, amount/close-date
   * edited. The receiving function debounces 5 minutes per deal so a burst of
   * edits collapses to one recompute.
   */
  'crm/deal.health_recompute': {
    tenantId: string;
    dealId: string;
    /** What triggered it — surfaced on the workflow run row. */
    reason: string;
  };
  /** Lead capture (0072): a raw payload was stored; process it. */
  'crm/lead.ingest_received': {
    tenantId: string;
    eventId: string;
  };
  /** A captured lead deal was created and needs an owner. */
  'crm/lead.created': {
    tenantId: string;
    dealId: string;
    sourceId: string | null;
  };
  /** Ask the distributor to (re)run for one lead. */
  'crm/lead.reassign_requested': {
    tenantId: string;
    dealId: string;
    excludeUserIds?: string[];
  };
  'crm/lead.assigned': {
    tenantId: string;
    dealId: string;
    userId: string;
    ruleId: string;
    slaDueAt: string;
  };
  /** Process a CSV import job in resumable chunks. */
  'crm/lead.import_requested': {
    tenantId: string;
    jobId: string;
  };
  'crm/lead.unassigned': {
    tenantId: string;
    dealId: string;
    reason: string;
  };
  /** Telephony (0073): one verified, normalized provider webhook. Dates are ISO strings. */
  'crm/call.event_received': {
    tenantId: string;
    accountId: string;
    provider: string;
    event: {
      providerCallId: string;
      direction: 'outbound' | 'inbound' | null;
      status: string;
      from: string | null;
      to: string | null;
      startedAt: string | null;
      answeredAt: string | null;
      endedAt: string | null;
      durationSec: number | null;
      talkTimeSec: number | null;
      recordingUrl: string | null;
      agentPhone: string | null;
      customData: string | null;
    };
  };
  /** A call reached a terminal status and has a provider recording to archive. */
  'crm/call.completed': {
    tenantId: string;
    callId: string;
  };
  /** Our copy of the recording is stored; transcription may run. */
  'crm/call.recording_archived': {
    tenantId: string;
    callId: string;
  };
  /** A user asked to retry a failed / skipped transcription (0076). */
  'crm/call.transcribe_requested': {
    tenantId: string;
    callId: string;
    requestedBy: string;
  };
  /** A transcript was stored (0076); the AI call summary may run. */
  'crm/call.transcribed': {
    tenantId: string;
    callId: string;
  };
  /** The Claude call summary was stored; AI field suggestions may run. */
  'crm/call.summarized': {
    tenantId: string;
    callId: string;
  };
  /** An email thread's AI summary was regenerated; AI field suggestions may run. */
  'crm/email.thread_summarized': {
    tenantId: string;
    threadId: string;
  };
  /** Reports (0074): run / continue a resumable rollup backfill job. */
  'crm/report.backfill_requested': {
    tenantId: string;
    jobId: string;
  };
};

export type WorkflowEventName = keyof WorkflowEvents;
