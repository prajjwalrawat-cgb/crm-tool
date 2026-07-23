import 'server-only';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  activityLogs,
  dealContacts,
  deals,
  stageGates,
  tasks,
  workspaceSettings,
  type DealStage,
  type StageGate,
} from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';
import { formatCurrency, toMinorUnits } from '@/lib/deals/currency';

import {
  GATE_REQUIRABLE_FIELDS,
  type AmountRequiredConfig,
  type CustomNoteConfig,
  type FieldRequiredConfig,
  type GateActivityType,
  type GateCta,
  type GateFailure,
  type GateResult,
  type GateRuleResult,
  type GateRuleType,
  type GateSeverity,
  type MinActivitiesConfig,
  type MinStakeholdersConfig,
  type TaskCompleteConfig,
} from './types';

/**
 * The genuine deal field-values a gate evaluates against. When a stage change
 * arrives together with field edits (the deal edit form), the caller passes an
 * `override` so a gate sees the values being SAVED, not the stale DB row —
 * otherwise setting the amount and advancing in one submit would wrongly block.
 */
export type DealGateOverride = Partial<{
  contactId: string | null;
  companyId: string | null;
  amountMinor: number;
  currency: string;
  competitor: string | null;
  nextStep: string | null;
  expectedCloseDate: string | null;
  source: string | null;
  dealType: string | null;
  description: string | null;
  customFields: Record<string, unknown>;
}>;

type DealSnapshot = {
  contactId: string | null;
  companyId: string | null;
  amountMinor: number;
  currency: string;
  competitor: string | null;
  nextStep: string | null;
  expectedCloseDate: string | null;
  source: string | null;
  dealType: string | null;
  description: string | null;
  customFields: Record<string, unknown>;
};

type GateContext = {
  snapshot: DealSnapshot;
  stakeholderCount: number;
  activityCountByType: Record<GateActivityType, number>;
  completedTaskTypes: Set<string>;
};

/** activity_logs verbs that count as a genuine (email/call/meeting) activity. */
const ACTIVITY_ACTION_TO_TYPE: Record<string, GateActivityType> = {
  call_logged: 'call',
  meeting_logged: 'meeting',
  email_sent: 'email',
  // Module 3: an email captured from a connected Gmail mailbox counts too.
  email_synced: 'email',
};

const GENUINE_ACTIVITY_ACTIONS = Object.keys(ACTIVITY_ACTION_TO_TYPE);
const GENUINE_TASK_TYPES = ['call', 'email', 'meeting'] as const;

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Is a `field_required` field filled in on the (post-edit) deal snapshot? */
function isFieldPresent(snap: DealSnapshot, key: string): boolean {
  switch (key) {
    case 'contact_id':
      return snap.contactId != null;
    case 'company_id':
      return snap.companyId != null;
    case 'amount':
      return snap.amountMinor > 0;
    case 'competitor':
      return nonEmpty(snap.competitor);
    case 'next_step':
      return nonEmpty(snap.nextStep);
    case 'expected_close_date':
      return nonEmpty(snap.expectedCloseDate);
    case 'source':
      return nonEmpty(snap.source);
    case 'deal_type':
      return snap.dealType != null;
    case 'description':
      return nonEmpty(snap.description);
    default: {
      // Unknown key → treat as a custom-field key.
      const v = snap.customFields?.[key];
      if (v == null) return false;
      if (typeof v === 'string') return v.trim().length > 0;
      return true;
    }
  }
}

function fieldLabel(key: string): string {
  const known = GATE_REQUIRABLE_FIELDS.find((f) => f.key === key);
  return known?.label ?? key;
}

function fieldCta(key: string): GateCta {
  if (key === 'amount') return { label: 'Set amount', kind: 'field', field: 'amount' };
  if (key === 'contact_id')
    return { label: 'Add contact', kind: 'field', field: 'contact_id' };
  if (key === 'company_id')
    return { label: 'Add company', kind: 'field', field: 'company_id' };
  return { label: `Add ${fieldLabel(key).toLowerCase()}`, kind: 'field', field: key };
}

/**
 * Gather everything the rules need in a handful of small indexed queries. When
 * `dealId` is null (a brand-new deal being created directly at a gated stage)
 * the count-based signals are 0 and only the field/amount/note rules can pass.
 */
async function gatherContext(
  exec: DbExecutor,
  tenantId: string,
  dealId: string | null,
  override: DealGateOverride | undefined,
): Promise<GateContext> {
  let base: DealSnapshot = {
    contactId: null,
    companyId: null,
    amountMinor: 0,
    currency: 'INR',
    competitor: null,
    nextStep: null,
    expectedCloseDate: null,
    source: null,
    dealType: null,
    description: null,
    customFields: {},
  };

  let stakeholderCount = 0;
  const activityCountByType: Record<GateActivityType, number> = {
    email: 0,
    call: 0,
    meeting: 0,
  };
  const completedTaskTypes = new Set<string>();

  if (dealId) {
    const [row] = await exec
      .select({
        contactId: deals.contactId,
        companyId: deals.companyId,
        amountMinor: deals.amountMinor,
        currency: deals.currency,
        competitor: deals.competitor,
        nextStep: deals.nextStep,
        expectedCloseDate: deals.expectedCloseDate,
        source: deals.source,
        dealType: deals.dealType,
        description: deals.description,
        customFields: deals.customFields,
      })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)))
      .limit(1);
    if (row) {
      base = {
        contactId: row.contactId,
        companyId: row.companyId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        competitor: row.competitor,
        nextStep: row.nextStep,
        expectedCloseDate: row.expectedCloseDate,
        source: row.source,
        dealType: row.dealType,
        description: row.description,
        customFields: (row.customFields as Record<string, unknown>) ?? {},
      };
    }

    const stakeholderRows = await exec
      .select({ id: dealContacts.id })
      .from(dealContacts)
      .where(
        and(eq(dealContacts.tenantId, tenantId), eq(dealContacts.dealId, dealId)),
      );
    stakeholderCount = stakeholderRows.length;

    const activityRows = await exec
      .select({ action: activityLogs.action })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityType, 'deal'),
          eq(activityLogs.entityId, dealId),
          inArray(activityLogs.action, GENUINE_ACTIVITY_ACTIONS),
        ),
      );
    for (const a of activityRows) {
      const t = ACTIVITY_ACTION_TO_TYPE[a.action];
      if (t) activityCountByType[t] += 1;
    }

    const taskRows = await exec
      .select({ type: tasks.type })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.entityType, 'deal'),
          eq(tasks.entityId, dealId),
          eq(tasks.status, 'completed'),
          isNull(tasks.deletedAt),
        ),
      );
    for (const t of taskRows) {
      if (!t.type) continue;
      completedTaskTypes.add(t.type);
      // A completed call/email/meeting task also counts as a genuine activity.
      if ((GENUINE_TASK_TYPES as readonly string[]).includes(t.type)) {
        activityCountByType[t.type as GateActivityType] += 1;
      }
    }
  }

  // Merge caller overrides (the values being saved this transition) over the DB row.
  const snapshot: DealSnapshot = { ...base };
  if (override) {
    for (const key of Object.keys(override) as (keyof DealGateOverride)[]) {
      const val = override[key];
      if (val !== undefined) {
        // @ts-expect-error index assignment across the union is safe here.
        snapshot[key] = val;
      }
    }
  }

  return { snapshot, stakeholderCount, activityCountByType, completedTaskTypes };
}

/** Evaluate one gate row against the gathered context. */
function evaluateRule(
  gate: StageGate,
  ctx: GateContext,
  gateNote: string | undefined,
): GateRuleResult {
  const ruleType = gate.ruleType as GateRuleType;
  const severity = gate.severity as GateSeverity;
  const base = { id: gate.id, ruleType, severity };

  switch (ruleType) {
    case 'field_required': {
      const cfg = gate.ruleConfig as FieldRequiredConfig;
      const fields = Array.isArray(cfg.fields) ? cfg.fields : [];
      const missing = fields.filter((f) => !isFieldPresent(ctx.snapshot, f));
      const satisfied = missing.length === 0;
      return {
        ...base,
        satisfied,
        message: satisfied
          ? `All required fields set (${fields.map(fieldLabel).join(', ')})`
          : `Fill in: ${missing.map(fieldLabel).join(', ')}`,
        cta: satisfied ? null : fieldCta(missing[0]!),
      };
    }
    case 'min_stakeholders': {
      const cfg = gate.ruleConfig as MinStakeholdersConfig;
      const count = Number(cfg.count) || 0;
      const satisfied = ctx.stakeholderCount >= count;
      return {
        ...base,
        satisfied,
        message: satisfied
          ? `${ctx.stakeholderCount} stakeholder(s) linked`
          : `Link at least ${count} stakeholder(s) — have ${ctx.stakeholderCount}`,
        cta: satisfied ? null : { label: 'Add stakeholder', kind: 'stakeholder' },
      };
    }
    case 'min_activities': {
      const cfg = gate.ruleConfig as MinActivitiesConfig;
      const count = Number(cfg.count) || 0;
      const types = (
        Array.isArray(cfg.types) ? cfg.types : ['email', 'call', 'meeting']
      ) as GateActivityType[];
      const total = types.reduce(
        (sum, t) => sum + (ctx.activityCountByType[t] ?? 0),
        0,
      );
      const satisfied = total >= count;
      return {
        ...base,
        satisfied,
        message: satisfied
          ? `${total} logged ${types.join('/')} activit${total === 1 ? 'y' : 'ies'}`
          : `Log at least ${count} ${types.join('/')} activit${count === 1 ? 'y' : 'ies'} — have ${total}`,
        cta: satisfied ? null : { label: 'Log an activity', kind: 'activity' },
      };
    }
    case 'amount_required': {
      const cfg = gate.ruleConfig as AmountRequiredConfig;
      const min = Number(cfg.min) || 0;
      const threshold = toMinorUnits(min, ctx.snapshot.currency);
      const satisfied = ctx.snapshot.amountMinor >= threshold;
      return {
        ...base,
        satisfied,
        message: satisfied
          ? `Amount meets ${formatCurrency(threshold, ctx.snapshot.currency)} minimum`
          : `Deal amount must be at least ${formatCurrency(threshold, ctx.snapshot.currency)}`,
        cta: satisfied ? null : { label: 'Set amount', kind: 'field', field: 'amount' },
      };
    }
    case 'task_complete': {
      const cfg = gate.ruleConfig as TaskCompleteConfig;
      const taskType = String(cfg.task_type ?? '');
      const satisfied = ctx.completedTaskTypes.has(taskType);
      return {
        ...base,
        satisfied,
        message: satisfied
          ? `Completed "${taskType}" task on this deal`
          : `Complete a "${taskType}" task on this deal`,
        cta: satisfied ? null : { label: 'Add task', kind: 'task' },
      };
    }
    case 'custom_note': {
      const cfg = gate.ruleConfig as CustomNoteConfig;
      const prompt = String(cfg.prompt ?? 'Add a justification note');
      const satisfied = nonEmpty(gateNote);
      return {
        ...base,
        satisfied,
        message: satisfied ? `Justification recorded` : prompt,
        cta: satisfied ? null : { label: 'Add a note', kind: 'note' },
      };
    }
    default:
      // Unknown rule type — fail open (do not block on config we can't read).
      return {
        ...base,
        satisfied: true,
        message: 'Unknown rule (skipped)',
        cta: null,
      };
  }
}

/** Read the active gates guarding entry into `stage`, ordered stably. */
async function loadActiveGates(
  exec: DbExecutor,
  tenantId: string,
  stage: DealStage,
): Promise<StageGate[]> {
  return exec
    .select()
    .from(stageGates)
    .where(
      and(
        eq(stageGates.tenantId, tenantId),
        eq(stageGates.stage, stage),
        eq(stageGates.isActive, true),
      ),
    );
}

/** Is the STAGE_GATES_ENABLED flag on for this tenant? No row = OFF (default). */
async function stageGatesEnabled(
  exec: DbExecutor,
  tenantId: string,
): Promise<boolean> {
  const [row] = await exec
    .select({ enabled: workspaceSettings.stageGatesEnabled })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.tenantId, tenantId))
    .limit(1);
  return row?.enabled === true;
}

export type EvaluateStageTransitionParams = {
  tenantId: string;
  /** Null when evaluating a create (deal row does not exist yet). */
  dealId: string | null;
  fromStage: DealStage | null;
  toStage: DealStage;
  /** Post-edit field values, when the stage change rides a field edit. */
  override?: DealGateOverride;
  /** Justification captured for a `custom_note` gate at transition time. */
  gateNote?: string;
};

/**
 * THE enforcement primitive. Returns `{ allowed, failures }` for entering
 * `toStage`. `allowed` is false only when a `block`-severity rule fails; `warn`
 * failures are returned too (allowed stays true) so the caller can log them as
 * `gate_warning` activity. When the feature flag is off, or no active gates
 * guard the stage, every transition is allowed.
 *
 * Must be called with an `exec` bound to the tenant's RLS context (a tx from
 * `tenantTransaction`, or `db` inside `runWithTenantContext`).
 */
export async function evaluateStageTransition(
  exec: DbExecutor,
  params: EvaluateStageTransitionParams,
): Promise<GateResult> {
  const { tenantId, dealId, toStage, override, gateNote } = params;

  if (!(await stageGatesEnabled(exec, tenantId))) {
    return { allowed: true, failures: [] };
  }

  const gates = await loadActiveGates(exec, tenantId, toStage);
  if (gates.length === 0) return { allowed: true, failures: [] };

  const ctx = await gatherContext(exec, tenantId, dealId, override);
  const results = gates.map((g) => evaluateRule(g, ctx, gateNote));

  const failures: GateFailure[] = results
    .filter((r) => !r.satisfied)
    .map((r) => ({
      rule_type: r.ruleType,
      severity: r.severity,
      message: r.message,
      cta: r.cta,
    }));

  const allowed = failures.every((f) => f.severity !== 'block');
  return { allowed, failures };
}

/**
 * Read-only Path-bar view: every active rule for `stage` with its live
 * satisfied/unsatisfied state. Returns [] when the flag is off or the stage
 * has no gates. `custom_note` rules read as unsatisfied here (they're a
 * transition-time prompt, not a stored field).
 */
export async function evaluateStageGatesForDeal(
  exec: DbExecutor,
  tenantId: string,
  dealId: string,
  stage: DealStage,
): Promise<GateRuleResult[]> {
  if (!(await stageGatesEnabled(exec, tenantId))) return [];
  const gates = await loadActiveGates(exec, tenantId, stage);
  if (gates.length === 0) return [];
  const ctx = await gatherContext(exec, tenantId, dealId, undefined);
  return gates.map((g) => evaluateRule(g, ctx, undefined));
}

export type PathBarGates = {
  enabled: boolean;
  byStage: Record<string, GateRuleResult[]>;
};

/**
 * Path-bar data for the deal-detail page: the live gate results for each of the
 * given stages, computed from a single shared context gather. Returns
 * `enabled: false` when the feature flag is off so the caller can hide the bar.
 * Opens its own tenant transaction — call from a server component under an
 * active tenant context.
 */
export async function getPathBarGates(
  tenantId: string,
  dealId: string,
  stages: DealStage[],
): Promise<PathBarGates> {
  return tenantTransaction(async (tx) => {
    if (!(await stageGatesEnabled(tx, tenantId))) {
      return { enabled: false, byStage: {} };
    }
    const ctx = await gatherContext(tx, tenantId, dealId, undefined);
    const byStage: Record<string, GateRuleResult[]> = {};
    for (const stage of stages) {
      const gates = await loadActiveGates(tx, tenantId, stage);
      byStage[stage] = gates.map((g) => evaluateRule(g, ctx, undefined));
    }
    return { enabled: true, byStage };
  });
}
