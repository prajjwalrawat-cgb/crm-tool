import type { FollowUpValue, SuggestionEntityType, SuggestionField, SuggestionSourceType, SuggestionValue } from '@/db/schema/ai-suggestions';

export const FIELD_LABELS: Record<SuggestionField, string> = {
  stage: 'Stage',
  amount: 'Amount',
  close_date: 'Close date',
  next_step: 'Next step',
  contact_name: 'Contact name',
  contact_email: 'Contact email',
  contact_phone: 'Contact phone',
  contact_designation: 'Designation',
  follow_up_task: 'Follow-up task',
  industry: 'Industry',
  size_band: 'Company size',
  product_fit: 'Product fit',
  icp_score: 'ICP score',
};

/** Client-safe view of a suggestion. Built on the server, rendered by SuggestionItem. */
export type SuggestionView = {
  id: string;
  field: SuggestionField;
  fieldLabel: string;
  entityType: SuggestionEntityType;
  entityId: string;
  entityName: string | null;
  entityHref: string | null;
  current: SuggestionValue;
  suggested: SuggestionValue;
  evidence: string;
  confidence: number;
  sourceType: SuggestionSourceType;
  sourceHref: string | null;
  createdAt: string;
  model: string;
};

/** Below this, an item is collapsed by default. */
export const LOW_CONFIDENCE = 0.6;

export function toSuggestionView(r: {
  id: string;
  field: SuggestionField;
  entityType: SuggestionEntityType;
  entityId: string;
  entityName: string | null;
  dealId: string | null;
  currentValueAtSuggestion: SuggestionValue;
  suggestedValue: SuggestionValue;
  evidenceQuote: string;
  confidence: number;
  sourceType: SuggestionSourceType;
  sourceId: string;
  createdAt: Date;
  model: string;
}): SuggestionView {
  const entityHref =
    r.entityType === 'contact'
      ? `/dashboard/contacts/${r.entityId}`
      : r.entityType === 'prospect'
        ? `/dashboard/prospects?p=${r.entityId}`
        : `/dashboard/deals/${r.entityId}`;
  let sourceHref: string | null = null;
  if (r.sourceType === 'call') sourceHref = r.dealId ? `/dashboard/deals/${r.dealId}#call-${r.sourceId}` : null;
  else if (r.sourceType === 'email') sourceHref = `/dashboard/communications/${r.sourceId.split(':')[0]}`;
  return {
    id: r.id,
    field: r.field,
    fieldLabel: FIELD_LABELS[r.field],
    entityType: r.entityType,
    entityId: r.entityId,
    entityName: r.entityName,
    entityHref,
    current: r.currentValueAtSuggestion,
    suggested: r.suggestedValue,
    evidence: r.evidenceQuote,
    confidence: r.confidence,
    sourceType: r.sourceType,
    sourceHref,
    createdAt: r.createdAt.toISOString(),
    model: r.model,
  };
}

const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  hold: 'Hold',
  won: 'Won',
  lost: 'Lost',
};

export function formatSuggestionValue(field: SuggestionField, v: SuggestionValue): string {
  if (v == null || v === '') return '—';
  if (field === 'follow_up_task' && typeof v === 'object') {
    const f = v as FollowUpValue;
    return `${f.title} (due ${f.due_date})`;
  }
  if (field === 'amount' && typeof v === 'number') return v.toLocaleString('en-IN');
  if (field === 'stage' && typeof v === 'string') return STAGE_LABEL[v] ?? v;
  return String(v);
}
