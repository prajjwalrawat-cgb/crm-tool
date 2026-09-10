/**
 * The company rollup shape, plus the display decisions that go with it.
 *
 * Client- and server-safe (no `server-only` import) because the Companies
 * table renders these values and the query layer produces them, and the
 * two must agree about what "nothing" looks like. See migration
 * `0065_company_rollups.sql` for where the numbers come from.
 */

import type { DealStage } from '@/lib/deals/schema';

export type CompanyRollupFields = {
  /** Every non-deleted deal on the account, any stage. */
  dealCount: number;
  /** Deals whose stage is neither `won` nor `lost` (`hold` counts as open). */
  openDealCount: number;
  wonDealCount: number;
  /** Minor units, summed across the account's deal currencies. */
  openPipelineValue: number;
  /** Minor units, summed across the account's deal currencies. */
  wonLifetimeValue: number;
  /** Stage of the most recently updated open deal; NULL when there is none. */
  topStage: DealStage | null;
  contactCount: number;
  /** Newest company activity row, company note, or deal update. */
  lastActivityAt: Date | null;
};

/**
 * The rollup an account has before the database has said otherwise:
 * everything zero, nothing ever happened. Used for optimistic rows (a
 * company created in this render has no deals yet, by construction) and
 * as the fallback for the LEFT JOIN, which is typed nullable even though
 * the view returns one row per company.
 *
 * Zeroes, not nulls, because the difference between "no deals" and "we
 * have not looked" is not one this table can draw — and rendering `0` as
 * `—` is a decision `formatCount` makes below, once, for every caller.
 */
export const EMPTY_COMPANY_ROLLUP: CompanyRollupFields = {
  dealCount: 0,
  openDealCount: 0,
  wonDealCount: 0,
  openPipelineValue: 0,
  wonLifetimeValue: 0,
  topStage: null,
  contactCount: 0,
  lastActivityAt: null,
};

/**
 * Counts render as an em dash when there are none.
 *
 * A column of zeroes reads as data — the eye stops on every one of them
 * and has to decide it means nothing. An em dash is absence, and the scan
 * skips it. Guards against NaN/Infinity too: an aggregate that arrives
 * malformed should read as "no data", never as the string "NaN" in a
 * table cell.
 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—';
  return String(n);
}

/**
 * Whether the account has an open-pipeline figure worth printing.
 *
 * The distinction this exists to preserve: an account with two open deals
 * that happen to carry no amount yet is NOT the same as an account with
 * no open deals. The first gets a real "₹0 open" — someone is working it
 * and has not priced it. The second gets "— open". Collapsing both to a
 * dash loses the only cue that the first one needs an amount typed in.
 */
export function hasOpenPipeline(r: CompanyRollupFields): boolean {
  return r.openDealCount > 0;
}

/** Same rule for the won half: printed whenever a deal has ever closed won. */
export function hasWonValue(r: CompanyRollupFields): boolean {
  return r.wonDealCount > 0;
}
