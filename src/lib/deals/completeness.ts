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
  /**
   * SQL boolean saying the field is filled, built for whatever alias the
   * caller's `deals` row carries. A function rather than a fixed string
   * because two very different queries need the same predicate: the
   * per-rep aggregate (alias `d`, inside its own CTE) and the Deals list's
   * `missing=` filter (alias `deals`, drizzle's default). Writing it twice
   * would be the same rule in two places — the thing this module exists to
   * prevent. No user input, ever: the alias is a compile-time constant at
   * every call site.
   */
  filledSql: (alias: string) => string;
  /**
   * Where red becomes amber and amber becomes green FOR THIS FIELD.
   *
   * Not one global constant, because fields have different realistic
   * ceilings: Contact is filled on 92% of the deals that owe it and Source
   * on under 1%, so a single bar either paints Source permanently red
   * (carrying no information from one month to the next) or lets Contact
   * fall 30 points while staying green. The numbers are a POLICY — what
   * good looks like for this field — not a percentile of current data;
   * deriving them from the live distribution would move every rep's colour
   * whenever another rep improved, and would quietly bless whatever the
   * team already does.
   */
  thresholds: FieldThresholds;
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
 * Per-field colour thresholds for the scorecard heatmap.
 *
 * `amberFrom` / `greenFrom` are percentages of the deals that OWE the field.
 * Below `amberFrom` is red.
 */
export type FieldThresholds = { amberFrom: number; greenFrom: number };

/**
 * The default ladder, used by the Overall column and by required custom
 * fields (which the workspace declared but about which this codebase has
 * no opinion).
 */
export const DEFAULT_FIELD_THRESHOLDS: FieldThresholds = {
  amberFrom: 40,
  greenFrom: 75,
};

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
    filledSql: (d) => `(${d}.company_id IS NOT NULL OR ${textSql(`${d}.company_name`)})`,
    isFilled: (d) => d.companyId != null || hasText(d.companyNameText),
    /** Near-universal today (71%); a deal with no company is unusable downstream. */
    thresholds: { amberFrom: 60, greenFrom: 90 },
  },
  {
    key: 'contact',
    group: 'identity',
    label: 'Contact',
    hint: 'Someone on the other side of the deal',
    requiredFromRank: 1,
    filledSql: (d) => `(${d}.contact_id IS NOT NULL OR ${textSql(`${d}.contact_name`)})`,
    isFilled: (d) => d.contactId != null || hasText(d.contactNameText),
    /** Filled on 92% of deals that owe it — the bar is set where that stays green and a slip shows. */
    thresholds: { amberFrom: 60, greenFrom: 90 },
  },
  {
    key: 'contact_email',
    group: 'identity',
    label: 'Contact email',
    hint: 'Required from Qualified — without it nothing can be sent or synced',
    requiredFromRank: 2,
    filledSql: (d) => textSql(`${d}.contact_email`),
    isFilled: (d) => hasText(d.contactEmailText),
    /** At 0% team-wide; a reachable first rung, or the column never leaves red and stops being read. */
    thresholds: { amberFrom: 25, greenFrom: 60 },
  },
  {
    key: 'amount',
    group: 'financials',
    label: 'Value',
    hint: 'A deal worth 0 is a deal missing from every forecast',
    requiredFromRank: 1,
    filledSql: (d) => `COALESCE(${d}.amount_minor, 0) > 0`,
    isFilled: (d) => (d.amountMinor ?? 0) > 0,
    /** Forecast-critical: a deal worth 0 is missing from every projection. */
    thresholds: { amberFrom: 50, greenFrom: 85 },
  },
  {
    key: 'margin',
    group: 'financials',
    label: 'Margin',
    hint: 'Mandatory from Qualified on; a NULL margin scores as zero margin on the targets page',
    requiredFromRank: 2,
    filledSql: (d) => `${d}.margin_bps IS NOT NULL AND ${d}.margin_bps > 0`,
    isFilled: (d) => d.marginBps != null && d.marginBps > 0,
    /** Mandatory from Qualified, and a NULL reads as zero margin on the targets page. */
    thresholds: { amberFrom: 50, greenFrom: 85 },
  },
  {
    key: 'value_split',
    group: 'financials',
    label: 'Revenue breakdown',
    hint: 'Without it the whole contract value is counted against this fiscal year',
    requiredFromRank: 3,
    filledSql: (d) => `EXISTS (SELECT 1 FROM deal_value_splits s WHERE s.deal_id = ${d}.id)`,
    isFilled: (d) => d.hasValueSplit,
    /** Newest field, 10% adoption; graded on progress rather than against a ceiling nobody has reached. */
    thresholds: { amberFrom: 25, greenFrom: 60 },
  },
  {
    key: 'close_date',
    group: 'metadata',
    label: 'Close date',
    hint: 'Mandatory from Proposal on (chk_close_date_required); a Lead must NOT carry one',
    requiredFromRank: 3,
    filledSql: (d) => `${d}.expected_close_date IS NOT NULL`,
    isFilled: (d) => d.expectedCloseDate != null,
    /** Forecast-critical and already enforced by chk_close_date_required from Proposal on. */
    thresholds: { amberFrom: 60, greenFrom: 90 },
  },
  {
    key: 'deal_type',
    group: 'metadata',
    label: 'Deal type',
    hint: 'New logo / renewal / expansion / upsell — new-business reporting needs it',
    requiredFromRank: 1,
    filledSql: (d) => `${d}.deal_type IS NOT NULL`,
    isFilled: (d) => d.dealType != null,
    /** Reporting input rather than a blocker; graded gently. */
    thresholds: { amberFrom: 30, greenFrom: 70 },
  },
  {
    key: 'source',
    group: 'metadata',
    label: 'Source',
    hint: 'Where the deal came from — the only input to channel ROI',
    requiredFromRank: 1,
    filledSql: (d) => textSql(`${d}.source`),
    isFilled: (d) => hasText(d.source),
    /** Under 1% today; the ladder starts where the team actually stands. */
    thresholds: { amberFrom: 25, greenFrom: 60 },
  },
  {
    key: 'next_step',
    group: 'execution',
    label: 'Next step',
    hint: 'What has to happen to close. The one field a pipeline review reads first',
    requiredFromRank: 2,
    filledSql: (d) => textSql(`${d}.next_step`),
    isFilled: (d) => hasText(d.nextStep),
    /** What a pipeline review reads first, but at 2% today the bar has to be climbable. */
    thresholds: { amberFrom: 30, greenFrom: 70 },
  },
  {
    key: 'description',
    group: 'execution',
    label: 'Description',
    hint: 'What the deal is actually for — the handover-when-a-rep-leaves field',
    requiredFromRank: 2,
    filledSql: (d) => textSql(`${d}.description`),
    isFilled: (d) => hasText(d.description),
    /** A soft field; holding it to the same bar as Value would make both meaningless. */
    thresholds: { amberFrom: 25, greenFrom: 60 },
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

/** SQL mirror of `fieldApplies`, for a `deals` row under `alias`. */
export function fieldAppliesSql(spec: DealFieldSpec, alias = 'd'): string {
  if (spec.requiredFromRank <= 1) return 'TRUE';
  // deal_stage_rank() (migration 0060) returns NULL for hold/lost; the
  // COALESCE is what makes those stages rank 1, exactly as above.
  return `COALESCE(deal_stage_rank(${alias}.stage), 1) >= ${spec.requiredFromRank}`;
}

/**
 * "This deal OWES the field and does not have it" — the predicate behind
 * the Deals list's `missing=<field>` filter, and therefore behind every
 * drill-through from a heatmap cell.
 *
 * Owing is half the definition and the half that is easy to drop: a Lead
 * with no close date is not missing one, it is forbidden from having one.
 * A filter built from `NOT filled` alone would open a list of deals the
 * rep cannot act on, under a cell that never counted them.
 */
export function fieldMissingSql(spec: DealFieldSpec, alias = 'd'): string {
  return `(${fieldAppliesSql(spec, alias)}) AND NOT (${spec.filledSql(alias)})`;
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
 * Deliberately coarse. The number a band colours is a hygiene signal, not
 * a measurement, and three tiers stop a 2-point difference between two
 * reps from reading as a ranking.
 *
 * ONE LADDER PER FIELD, ALL OF THEM DECLARED ON THE SPEC ABOVE. Every
 * surface — the heatmap cell, the Overall column, the KPI tile, the
 * weakest-field callout — colours through `bandFor`, so a cell reading 60%
 * cannot be amber in one place and green three inches away.
 *
 * WHY NOT ONE GLOBAL CUT-OFF. Measured across every tenant, the fields
 * this table scores sit anywhere from 0% (Contact email, Source) to 92%
 * (Contact) filled. A single 40/80 bar put 57% of all cells in red and
 * only 7% in amber — not because the thresholds were wrong but because the
 * data is bimodal: a field is either filled out of habit or never touched.
 * A permanently-red column tells a manager nothing from one month to the
 * next, and the same bar lets a field at 92% fall thirty points while
 * staying green. Per-field ladders make both movements visible.
 *
 * WHY NOT DERIVE THEM FROM THE DATA. A percentile of the live distribution
 * would repaint every rep's row whenever another rep improved, and would
 * quietly define "good" as "whatever the team already does". The numbers
 * on each spec are a policy about what that field is worth, informed by
 * where the team stands but not dictated by it.
 */

export type CompletenessBand = 'good' | 'patchy' | 'poor';

/**
 * Band for a DISPLAYED percentage (0–100) against a field's ladder.
 *
 * Takes the percentage the caller is about to render rather than the raw
 * ratio: colouring off the unrounded value is what makes a cell reading
 * "75%" come out amber because it was really 0.7496.
 */
export function bandFor(
  pct: number,
  thresholds: FieldThresholds = DEFAULT_FIELD_THRESHOLDS,
): CompletenessBand {
  if (pct >= thresholds.greenFrom) return 'good';
  if (pct >= thresholds.amberFrom) return 'patchy';
  return 'poor';
}

/**
 * The ladder for one field key. Anything without its own — the Overall
 * column, a required custom field — falls back to the default.
 */
export function thresholdsFor(
  fieldKey: string | null | undefined,
): FieldThresholds {
  if (!fieldKey) return DEFAULT_FIELD_THRESHOLDS;
  return (
    DEAL_FIELD_SPECS.find((s) => s.key === fieldKey)?.thresholds ??
    DEFAULT_FIELD_THRESHOLDS
  );
}

/** `filled / applicable` as a 0–1 ratio; 1 when nothing is applicable. */
export function ratioOf(filled: number, applicable: number): number {
  if (applicable <= 0) return 1;
  return filled / applicable;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
