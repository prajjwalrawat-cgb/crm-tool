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
};

export type WorkflowEventName = keyof WorkflowEvents;
