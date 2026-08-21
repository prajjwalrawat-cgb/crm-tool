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

export function validateDealForm(fd: FormData): Record<string, string[]> {
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

  return errs;
}
