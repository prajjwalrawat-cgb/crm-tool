/**
 * Client-side pre-submit validation for the deal create/edit forms. Mirrors
 * the required-field rules in `createDealSchema` so we can block the server
 * action BEFORE it fires — a failed round-trip would otherwise reset the form
 * (React 19 resets a form after its action runs) and silently blank the
 * controlled Company/Contact selects. Returns field errors keyed the same way
 * the server does (`name`, `marginPct`, …); empty object = OK to submit.
 */
import {
  MARGIN_REQUIRED_MESSAGE,
  marginRequiredForStage,
} from '@/lib/deals/validation';
import {
  CLOSE_DATE_CLEAR_BLOCKED_MESSAGE,
  closeDateRequiredMessage,
  ROLLBACK_REASON_REQUIRED_MESSAGE,
  isRollbackTransition,
  violatesCloseDateClear,
  violatesMissingCloseDate,
} from '@/lib/deals/stage-governance';

/**
 * `previous` describes the deal being EDITED, and is omitted on create. The
 * rules that compare against a stored value (R2's backward move, R3's date
 * clear) can only run when it's supplied; the create form simply has nothing
 * to move backward from or blank.
 */
export type PreviousDealState = {
  stage: string;
  expectedCloseDate: string | null;
};

export function validateDealForm(
  fd: FormData,
  previous?: PreviousDealState | null,
): Record<string, string[]> {
  const errs: Record<string, string[]> = {};

  const name = String(fd.get('name') ?? '').trim();
  if (!name) errs.name = ['Name is required'];

  const stage = String(fd.get('stage') ?? '');
  const marginRaw = String(fd.get('marginPct') ?? '').trim();
  if (!marginRaw) {
    // Blank margin is fine in Lead (and Hold/Lost) — the rep doesn't know it
    // yet. Every other stage must carry one.
    if (marginRequiredForStage(stage)) errs.marginPct = [MARGIN_REQUIRED_MESSAGE];
  } else {
    const n = Number(marginRaw);
    if (!Number.isFinite(n) || n <= 0) {
      errs.marginPct = ['Margin must be greater than 0'];
    } else if (n > 100) {
      errs.marginPct = ['Margin cannot exceed 100%'];
    }
  }

  // A deal marked Lost must carry a reason.
  if (stage === 'lost') {
    if (!String(fd.get('lostReason') ?? '').trim()) {
      errs.lostReason = ['A reason is required when marking a deal Lost'];
    }
  }

  // R1 — Proposal / Negotiation / Won can't be saved without a close date.
  // The field is hidden entirely in Lead (a Lead may not carry one), so this
  // reads whatever the form actually submitted rather than assuming presence.
  const closeDate = String(fd.get('expectedCloseDate') ?? '').trim();
  if (violatesMissingCloseDate(stage, closeDate)) {
    errs.expectedCloseDate = [closeDateRequiredMessage(stage)];
  }

  if (previous) {
    // R3 — an existing date can't be blanked while the deal stays in a
    // date-required stage. Checked against the stage being SAVED, so an edit
    // that rolls the deal back and drops the date in one submit is allowed.
    if (
      violatesCloseDateClear({
        nextStage: stage,
        previousCloseDate: previous.expectedCloseDate,
        nextCloseDate: closeDate,
      })
    ) {
      errs.expectedCloseDate = [CLOSE_DATE_CLEAR_BLOCKED_MESSAGE];
    }

    // R2 — a backward stage move needs a reason code. The drawer collects one
    // into a hidden input once the user confirms the move; if it's still
    // missing at submit time, stop here rather than spending a round-trip.
    if (
      isRollbackTransition(previous.stage, stage) &&
      !String(fd.get('rollbackReason') ?? '').trim()
    ) {
      errs.rollbackReason = [ROLLBACK_REASON_REQUIRED_MESSAGE];
    }
  }

  return errs;
}
