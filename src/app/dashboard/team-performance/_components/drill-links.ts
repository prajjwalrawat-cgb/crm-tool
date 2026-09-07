import {
  dealFiltersToSearchParams,
  type DealFilters,
} from '@/lib/deals/filters';
import { DEAL_STAGES } from '@/lib/deals/schema';

/**
 * DRILL-THROUGH — every number on this page opens the deals behind it.
 *
 * The URLs are built by handing a `DealFilters` object to the Deals view's
 * OWN serializer rather than by concatenating query strings here. That is the
 * whole point: `dealFiltersToSearchParams` and `parseDealFilters` are a
 * matched pair, so a link built through it either round-trips or fails to
 * compile — it cannot silently produce a filter the list ignores and land the
 * user on an unfiltered page that looks like the right one.
 *
 * SCOPE HAS TO MATCH THE CELL. Every figure in the completeness and
 * engagement tables counts OPEN deals only, so every link from them carries
 * the open-stage list. A link that opened "all 312 deals" under a cell
 * reading "12" would be worse than no link: it looks like an answer.
 */

/** Everything that isn't closed. The cohort all three tables count. */
export const OPEN_STAGES = DEAL_STAGES.filter(
  (s) => s !== 'won' && s !== 'lost',
);

export type DrillTarget = {
  /** Scope to one rep's deals. Omit for a team-wide row. */
  ownerId?: string | null;
  /** Restrict to open stages — true for anything counted as "open". */
  openOnly?: boolean;
  /** A completeness field key: deals that owe it and lack it. */
  missingField?: string;
  /** Open deals with no write for the staleness threshold. */
  stale?: boolean;
  /** Deals whose close date has been pushed at least once. */
  slipped?: boolean;
};

export function dealsHref(target: DrillTarget): string {
  const filters: DealFilters = {};
  if (target.ownerId) filters.ownerIds = [target.ownerId];
  if (target.openOnly) filters.stages = [...OPEN_STAGES];
  if (target.missingField) filters.missingField = target.missingField;
  // `stale` already implies open in the query builder, but the stage list is
  // kept explicit so the chips the user lands on describe the same cohort the
  // cell counted rather than leaving them to infer it.
  if (target.stale) filters.stale = true;
  if (target.slipped) filters.slipped = true;
  const qs = dealFiltersToSearchParams(filters).toString();
  return qs ? `/dashboard/deals?${qs}` : '/dashboard/deals';
}
