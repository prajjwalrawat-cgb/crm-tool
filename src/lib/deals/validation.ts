/**
 * Cross-cutting deal business rules (pure, shared).
 */

/** Shown when a deal with a close date is (or would be) left in the Lead stage. */
export const LEAD_CLOSE_DATE_MESSAGE =
  'A deal with a close date can’t be in Lead — move it to Qualified or a higher stage.';

/**
 * Business rule: a deal that has an Expected Close Date must not sit in the
 * Lead stage (a dated deal has been qualified enough to forecast). Returns true
 * when the (stage, closeDate) combination violates the rule.
 */
export function violatesLeadCloseDate(
  stage: string,
  expectedCloseDate: string | null | undefined,
): boolean {
  return (
    stage === 'lead' &&
    typeof expectedCloseDate === 'string' &&
    expectedCloseDate.trim().length > 0
  );
}

/* -------- Margin required outside Lead -------- */

/** Shown when a deal is (or would be) in a margin-bearing stage without one. */
export const MARGIN_REQUIRED_MESSAGE =
  'Margin % is required from Qualified onwards.';

/**
 * Stages a deal may sit in WITHOUT a gross margin. Lead is exempt because the
 * rep genuinely doesn't know the margin yet — it's an unqualified opportunity.
 * Hold and Lost are exempt for the same reason: a Lead can be parked or
 * closed-lost having never earned a margin, and blocking those moves would
 * strand it in Lead with no way out.
 */
export const MARGIN_OPTIONAL_STAGES = ['lead', 'hold', 'lost'] as const;

/** Does a deal in `stage` have to carry a margin? */
export function marginRequiredForStage(stage: string): boolean {
  return !(MARGIN_OPTIONAL_STAGES as readonly string[]).includes(stage);
}

/**
 * Business rule: every stage from Qualified onwards must carry a margin.
 * Returns true when the (stage, margin) combination violates it. `margin` is
 * unit-agnostic — pass a percentage or basis points; both are > 0 when set.
 */
export function violatesMissingMargin(
  stage: string,
  margin: number | null | undefined,
): boolean {
  return marginRequiredForStage(stage) && !(typeof margin === 'number' && margin > 0);
}
