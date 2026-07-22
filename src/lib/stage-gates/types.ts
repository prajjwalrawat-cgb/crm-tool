import type { DealStage } from '@/db/schema';

/**
 * Shared, dependency-free stage-gate vocabulary. No DB / server imports so the
 * settings UI, the Kanban slide-over, and the deal-detail Path bar can all
 * import the labels and rule metadata directly.
 */

export const GATE_RULE_TYPES = [
  'field_required',
  'min_stakeholders',
  'min_activities',
  'amount_required',
  'task_complete',
  'custom_note',
] as const;
export type GateRuleType = (typeof GATE_RULE_TYPES)[number];

export const GATE_SEVERITIES = ['block', 'warn'] as const;
export type GateSeverity = (typeof GATE_SEVERITIES)[number];

/** Task types a `task_complete` gate can require (matches the tasks.type enum). */
export const GATE_TASK_TYPES = [
  'call',
  'email',
  'meeting',
  'internal',
  'followup',
] as const;

/** Genuine activity types a `min_activities` gate can count. */
export const GATE_ACTIVITY_TYPES = ['email', 'call', 'meeting'] as const;
export type GateActivityType = (typeof GATE_ACTIVITY_TYPES)[number];

/**
 * Deal fields a `field_required` gate can require. Anything not listed here is
 * treated as a custom-field key and checked against the deal's custom_fields.
 */
export const GATE_REQUIRABLE_FIELDS = [
  { key: 'contact_id', label: 'Primary contact' },
  { key: 'company_id', label: 'Company' },
  { key: 'competitor', label: 'Competitor' },
  { key: 'next_step', label: 'Next step' },
  { key: 'expected_close_date', label: 'Expected close date' },
  { key: 'source', label: 'Source' },
  { key: 'deal_type', label: 'Deal type' },
  { key: 'description', label: 'Description' },
  { key: 'amount', label: 'Amount' },
] as const;

/** Human labels for the seven pipeline stages, in Path order. */
export const STAGE_LABELS: Record<DealStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  hold: 'Hold',
  won: 'Won',
  lost: 'Lost',
};

/** The forward funnel shown as chevrons on the Path bar (excludes hold/lost). */
export const PATH_STAGES: DealStage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
];

/* -------- rule config shapes -------- */

export type FieldRequiredConfig = { fields: string[] };
export type MinStakeholdersConfig = { count: number };
export type MinActivitiesConfig = { count: number; types: GateActivityType[] };
export type AmountRequiredConfig = { min: number };
export type TaskCompleteConfig = { task_type: string };
export type CustomNoteConfig = { prompt: string };

/* -------- evaluation result shapes -------- */

/**
 * A deep-link hint the UI turns into a one-click "fix it" affordance on the
 * blocked-drag slide-over. `kind` selects which drawer/field to open.
 */
export type GateCta = {
  label: string;
  kind: 'field' | 'stakeholder' | 'activity' | 'task' | 'note';
  /** For kind:'field' — the deal field to focus (e.g. 'amount', 'contact_id'). */
  field?: string;
};

/** One rule's evaluation against a deal (used by both enforcement and the Path bar). */
export type GateRuleResult = {
  id: string;
  ruleType: GateRuleType;
  severity: GateSeverity;
  satisfied: boolean;
  /** Plain-language requirement / why it failed. */
  message: string;
  cta: GateCta | null;
};

/** A single failed rule, in the shape the enforcement API returns to the client. */
export type GateFailure = {
  rule_type: GateRuleType;
  severity: GateSeverity;
  message: string;
  cta: GateCta | null;
};

export type GateResult = {
  /** True when no `block`-severity rule failed. `warn` failures do not block. */
  allowed: boolean;
  failures: GateFailure[];
};

/** Metadata driving the settings admin UI: label + default config per rule type. */
export const GATE_RULE_META: Record<
  GateRuleType,
  { label: string; description: string; defaultConfig: Record<string, unknown> }
> = {
  field_required: {
    label: 'Field required',
    description: 'One or more deal fields must be filled in.',
    defaultConfig: { fields: ['contact_id'] },
  },
  min_stakeholders: {
    label: 'Minimum stakeholders',
    description: 'The deal must have at least N linked stakeholders.',
    defaultConfig: { count: 1 },
  },
  min_activities: {
    label: 'Minimum activities',
    description: 'At least N logged activities of the chosen types.',
    defaultConfig: { count: 1, types: ['email', 'call', 'meeting'] },
  },
  amount_required: {
    label: 'Amount required',
    description: 'Deal amount must be at least this figure.',
    defaultConfig: { min: 1 },
  },
  task_complete: {
    label: 'Task completed',
    description: 'A completed task of the chosen type must exist on the deal.',
    defaultConfig: { task_type: 'call' },
  },
  custom_note: {
    label: 'Justification note',
    description: 'The rep must answer a prompt when moving into this stage.',
    defaultConfig: { prompt: 'Why are we confident?' },
  },
};
