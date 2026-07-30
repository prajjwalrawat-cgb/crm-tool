import { type DealStage } from './schema';

/**
 * Close-date pushback ("timeline pushed") classification. Pure and
 * client-safe — the kanban card, the deal detail page and the self-test all
 * read the thresholds from here so a card, a label and a test can never
 * disagree about what counts as slipping.
 *
 * The counters themselves (`pushCount`, `totalSlipDays`, `originalCloseDate`)
 * are trigger-maintained columns on `deals`; see migration 0058.
 */

/** A deal at or past either of these is a hard "this is slipping" signal. */
export const SEVERE_PUSH_COUNT = 3;
export const SEVERE_SLIP_DAYS = 30;

export type SlipSeverity =
  /** Never pushed — no indicator at all. */
  | 'none'
  /** Pushed once or twice, under the slip-day threshold — chip only. */
  | 'watch'
  /** Pushed 3+ times or 30+ days slipped — chip plus a card accent. */
  | 'severe';

export type SlipFields = {
  pushCount: number | null;
  totalSlipDays: number | null;
};

export function slipSeverity(deal: SlipFields): SlipSeverity {
  const pushes = deal.pushCount ?? 0;
  const days = deal.totalSlipDays ?? 0;
  if (pushes <= 0) return 'none';
  if (pushes >= SEVERE_PUSH_COUNT || days >= SEVERE_SLIP_DAYS) return 'severe';
  return 'watch';
}

/**
 * Past its close date and still open. Independent of pushback: a deal nobody
 * has bothered to reschedule at all never registers as pushed, and that is its
 * own failure mode.
 *
 * `today` is passed in (rather than read from the clock) so server and client
 * renders agree on the first paint. Day precision is enough for a close date.
 */
export function isDealOverdue(
  deal: { expectedCloseDate: string | null; stage: DealStage | string },
  today: Date,
): boolean {
  if (!deal.expectedCloseDate) return false;
  if (deal.stage === 'won' || deal.stage === 'lost') return false;
  // expectedCloseDate is 'YYYY-MM-DD' from Drizzle's date column.
  return new Date(deal.expectedCloseDate) < today;
}

const tooltipDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** 'YYYY-MM-DD' -> 'Aug 31, 2026'. Empty input renders as an em dash. */
export function formatSlipDate(iso: string | null): string {
  if (!iso) return '—';
  return tooltipDateFormatter.format(new Date(iso));
}

/**
 * Hover text for the slip chip: the whole story in one line, so a manager
 * doesn't have to open the deal to know how far it has moved.
 */
export function slipTooltip(deal: {
  originalCloseDate: string | null;
  expectedCloseDate: string | null;
  pushCount: number | null;
  totalSlipDays: number | null;
}): string {
  const pushes = deal.pushCount ?? 0;
  const days = deal.totalSlipDays ?? 0;
  return (
    `Originally committed for ${formatSlipDate(deal.originalCloseDate)}, ` +
    `now ${formatSlipDate(deal.expectedCloseDate)} — ` +
    `pushed ${pushes}× (${days} ${days === 1 ? 'day' : 'days'} slipped)`
  );
}

/** Chip text: "Pushed ×3". */
export function slipChipLabel(pushCount: number | null): string {
  return `Pushed ×${pushCount ?? 0}`;
}
