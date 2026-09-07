/**
 * DEAL FIELD COMPLETENESS — which data points a deal owes at its current
 * stage, and whether they are actually there.
 *
 * Pure + client-safe: the spec below is the ONE definition of "filled",
 * written twice on purpose — once as a JS predicate and once as the SQL
 * the per-rep aggregate uses. `selftest-team-analytics` runs both over the
 * same rows and asserts they agree, which is the only thing that stops a
 * scorecard column and a deal form from disagreeing about whether a field
 * is missing (see `@/lib/targets/quota-credit` for the months-long version
 * of that bug).
 *
 * ---------------------------------------------------------------
 * COMPLETENESS IS STAGE-AWARE, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * A flat "12 of 14 fields filled" score punishes a rep for not knowing the
 * margin on a Lead they logged this morning — which is the exact thing the
 * margin rule deliberately allows (`./validation`). So every field carries
 * the stage it becomes owed at, taken from the rules that already exist:
 *
 *   * margin      — from Qualified on (`marginRequiredForStage`)
 *   * close date  — from Proposal on (the `chk_close_date_required` CHECK
 *                   in migration 0060). Lead is not merely exempt: a dated
 *                   Lead is a rule VIOLATION (`violatesLeadCloseDate`), so
 *                   the field is not applicable there at all.
 *   * breakdown   — from Proposal on. A deal with no `deal_value_splits`
 *                   rows is counted at full value against this fiscal year
 *                   by `targetAchievement`; that assumption is exactly what
 *                   makes multi-year attainment wrong, so the gap is
 *                   reported here rather than only footnoted there.
 *
 * A field that is not applicable is not counted in either the numerator or
 * the denominator. A rep with nothing but Leads is therefore scored on
 * what a Lead owes, not marked down for the rest.
 *
 * ---------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT SCORED
 * ---------------------------------------------------------------
 *   * `competitor` — "there is no competitor" is a real and common answer,
 *     and it is indistinguishable from an unfilled column. Scoring it would
 *     push reps to type something rather than leave it honestly empty.
 *   * `probability` — stage-derived by default (migration 0015); a rep
 *     never has to touch it.
 *   * `owner` — the aggregate groups BY owner, so an unowned deal has no
 *     rep to score. Unowned deals are reported as their own figure instead.
 *   * `currency`, `name` — NOT NULL with defaults; always "filled", so a
 *     column of 100% would be decoration.
 *
 * Required CUSTOM fields are scored, because an admin marking one required
 * is the workspace saying it is a data point a deal owes. Optional custom
 * fields are not.
 */

import { stageRank } from './stage-governance';

/** The columns a completeness check reads. Matches `deals` one-for-one. */
export type CompletenessDeal = {
  stage: string;
  companyId: string | null;
  companyNameText: string | null;
  contactId: string | null;
  contactNameText: string | null;
  contactEmailText: string | null;
  amountMinor: number | null;
  marginBps: number | null;
  expectedCloseDate: string | null;
  dealType: string | null;
  source: string | null;
  nextStep: string | null;
  description: string | null;
  /** Whether the deal has any `deal_value_splits` rows. */
  hasValueSplit: boolean;
  customFields: Record<string, unknown>;
};

/**
 * Display grouping for the scorecard's heatmap header. Presentation only —
 * grouping has no effect on scoring, and a field's group can be changed
 * without touching a single number.
 *
 * `custom` exists so a workspace's required custom fields land somewhere
 * honest instead of being wedged into a group whose name doesn't describe
 * them.
 */
export const FIELD_GROUPS = [
  { key: 'identity', label: 'Identity' },
  { key: 'financials', label: 'Financials' },
  { key: 'metadata', label: 'Deal metadata' },
  { key: 'execution', label: 'Execution' },
  { key: 'custom', label: 'Custom fields' },
] as const;

export type FieldGroupKey = (typeof FIELD_GROUPS)[number]['key'];

export function fieldGroupLabel(key: FieldGroupKey): string {
  return FIELD_GROUPS.find((g) => g.key === key)?.label ?? key;
}

export type DealFieldSpec = {
  /** Stable key — also the aggregate's column suffix. */
  key: string;
  label: string;
  /** Which header group this column sits under. Presentation only. */
  group: FieldGroupKey;
  /** Short "why this matters", rendered as the column tooltip. */
  hint: string;
  /**
   * Funnel rank (see `stageRank`) at which the field becomes owed. A deal
   * in an unranked stage (`hold`, `lost`) owes only rank-1 fields — it is
   * parked, not being worked.
   */
  requiredFromRank: 1 | 2 | 3;
  /** SQL boolean over a `deals d` in scope. No user input, ever. */
  filledSql: string;
  /** The same predicate in JS. */
  isFilled: (deal: CompletenessDeal) => boolean;
};

/** Trimmed-non-empty, the shape used for every text column below. */
function hasText(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** SQL mirror of `hasText` for one column. */
function textSql(column: string): string {
  return `NULLIF(BTRIM(COALESCE(${column}, '')), '') IS NOT NULL`;
}

/**
 * The scored data points, in the order they appear on the scorecard.
 *
 * ORDER IS GROUPED ORDER. The scorecard renders these under group headers
 * by walking this list once and chunking on `group`, so fields sharing a
 * group have to be adjacent here. Moving one changes only where its column
 * appears — the SQL aliases are positional but generated and consumed in
 * the same query, and the self-test compares by key.
 */
export const DEAL_FIELD_SPECS: readonly DealFieldSpec[] = [
  {
    key: 'company',
    group: 'identity',
    label: 'Company',
    hint: 'Linked company record, or at least a typed company name',
    requiredFromRank: 1,
    filledSql: `(d.company_id IS NOT NULL OR ${textSql('d.company_name')})`,
    isFilled: (d) => d.companyId != null || hasText(d.companyNameText),
  },
  {
    key: 'contact',
    group: 'identity',
    label: 'Contact',
    hint: 'Someone on the other side of the deal',
    requiredFromRank: 1,
    filledSql: `(d.contact_id IS NOT NULL OR ${textSql('d.contact_name')})`,
    isFilled: (d) => d.contactId != null || hasText(d.contactNameText),
  },
  {
    key: 'contact_email',
    group: 'identity',
    label: 'Contact email',
    hint: 'Required from Qualified — without it nothing can be sent or synced',
    requiredFromRank: 2,
    filledSql: textSql('d.contact_email'),
    isFilled: (d) => hasText(d.contactEmailText),
  },
  {
    key: 'amount',
    group: 'financials',
    label: 'Value',
    hint: 'A deal worth 0 is a deal missing from every forecast',
    requiredFromRank: 1,
    filledSql: 'COALESCE(d.amount_minor, 0) > 0',
    isFilled: (d) => (d.amountMinor ?? 0) > 0,
  },
  {
    key: 'margin',
    group: 'financials',
    label: 'Margin',
    hint: 'Mandatory from Qualified on; a NULL margin scores as zero margin on the targets page',
    requiredFromRank: 2,
    filledSql: 'd.margin_bps IS NOT NULL AND d.margin_bps > 0',
    isFilled: (d) => d.marginBps != null && d.marginBps > 0,
  },
  {
    key: 'value_split',
    group: 'financials',
    label: 'Revenue breakdown',
    hint: 'Without it the whole contract value is counted against this fiscal year',
    requiredFromRank: 3,
    filledSql: 'd.has_value_split',
    isFilled: (d) => d.hasValueSplit,
  },
  {
    key: 'close_date',
    group: 'metadata',
    label: 'Close date',
    hint: 'Mandatory from Proposal on (chk_close_date_required); a Lead must NOT carry one',
    requiredFromRank: 3,
    filledSql: 'd.expected_close_date IS NOT NULL',
    isFilled: (d) => d.expectedCloseDate != null,
  },
  {
    key: 'deal_type',
    group: 'metadata',
    label: 'Deal type',
    hint: 'New logo / renewal / expansion / upsell — new-business reporting needs it',
    requiredFromRank: 1,
    filledSql: 'd.deal_type IS NOT NULL',
    isFilled: (d) => d.dealType != null,
  },
  {
    key: 'source',
    group: 'metadata',
    label: 'Source',
    hint: 'Where the deal came from — the only input to channel ROI',
    requiredFromRank: 1,
    filledSql: textSql('d.source'),
    isFilled: (d) => hasText(d.source),
  },
  {
    key: 'next_step',
    group: 'execution',
    label: 'Next step',
    hint: 'What has to happen to close. The one field a pipeline review reads first',
    requiredFromRank: 2,
    filledSql: textSql('d.next_step'),
    isFilled: (d) => hasText(d.nextStep),
  },
  {
    key: 'description',
    group: 'execution',
    label: 'Description',
    hint: 'What the deal is actually for — the handover-when-a-rep-leaves field',
    requiredFromRank: 2,
    filledSql: textSql('d.description'),
    isFilled: (d) => hasText(d.description),
  },
] as const;

/**
 * Is this field owed by a deal in this stage?
 *
 * Unranked stages (`hold`, `lost`) are treated as rank 1: a parked deal is
 * still expected to say who it is with and what it is worth, but demanding
 * a next step from something explicitly parked would be noise.
 */
export function fieldApplies(spec: DealFieldSpec, stage: string): boolean {
  const rank = stageRank(stage) ?? 1;
  return rank >= spec.requiredFromRank;
}

/** SQL mirror of `fieldApplies`, over a `deals d` in scope. */
export function fieldAppliesSql(spec: DealFieldSpec): string {
  if (spec.requiredFromRank <= 1) return 'TRUE';
  // deal_stage_rank() (migration 0060) returns NULL for hold/lost; the
  // COALESCE is what makes those stages rank 1, exactly as above.
  return `COALESCE(deal_stage_rank(d.stage), 1) >= ${spec.requiredFromRank}`;
}

/**
 * A required custom field, promoted to a scored data point. `key` comes
 * from the database, so the SQL side binds it as a parameter rather than
 * interpolating — which is also why these are kept out of
 * `DEAL_FIELD_SPECS` (that list is compile-time constant).
 */
export type CustomFieldSpec = {
  key: string;
  label: string;
};

/** JS side of a required custom field's "filled" check. */
export function customFieldFilled(
  deal: Pick<CompletenessDeal, 'customFields'>,
  key: string,
): boolean {
  const raw = deal.customFields?.[key];
  if (raw == null) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'boolean') return true;
  return String(raw).trim().length > 0;
}

/** Applicable/filled tallies for one deal, across every scored field. */
export function scoreDeal(
  deal: CompletenessDeal,
  customFields: readonly CustomFieldSpec[] = [],
): { applicable: number; filled: number } {
  let applicable = 0;
  let filled = 0;
  for (const spec of DEAL_FIELD_SPECS) {
    if (!fieldApplies(spec, deal.stage)) continue;
    applicable += 1;
    if (spec.isFilled(deal)) filled += 1;
  }
  for (const cf of customFields) {
    applicable += 1;
    if (customFieldFilled(deal, cf.key)) filled += 1;
  }
  return { applicable, filled };
}

/* ---------------------------------------------------------------
 * Bands (the red / amber / green of the scorecard heatmap)
 * ---------------------------------------------------------------
 * Deliberately coarse. The number this produces is a hygiene signal,
 * not a measurement, and three bands stop a 2-point difference between
 * two reps from reading as a ranking.
 *
 * ONE SET OF THRESHOLDS, HERE. The heatmap cell, the overall column, the
 * KPI tile and the weakest-field callout all colour through
 * `completenessBand`, so a cell reading 80% cannot be green in one place
 * and amber three inches away.
 *
 * The cut-offs are flat across every field for now. They probably should
 * not stay that way: a missing Description on a Lead is not the same
 * failure as a missing Close date on a Proposal, and 40% on the first is
 * survivable where 40% on the second is a broken forecast. Per-field (or
 * per-stage) thresholds are the obvious next step — they belong on
 * `DealFieldSpec` when someone has an opinion about the numbers, not
 * scattered through the renderer.
 */

export type CompletenessBand = 'good' | 'patchy' | 'poor';

export const COMPLETENESS_GOOD = 0.8;
export const COMPLETENESS_PATCHY = 0.4;

export function completenessBand(ratio: number): CompletenessBand {
  if (ratio >= COMPLETENESS_GOOD) return 'good';
  if (ratio >= COMPLETENESS_PATCHY) return 'patchy';
  return 'poor';
}

/** `filled / applicable` as a 0–1 ratio; 1 when nothing is applicable. */
export function ratioOf(filled: number, applicable: number): number {
  if (applicable <= 0) return 1;
  return filled / applicable;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
