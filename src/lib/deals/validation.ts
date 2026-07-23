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
