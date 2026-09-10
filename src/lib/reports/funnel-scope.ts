/**
 * Funnel scope — which offering (or category, or the untagged remainder) the
 * Funnel by offering report is looking at, and how that scope round-trips
 * through the URL.
 *
 * Deliberately NOT `server-only`, and deliberately not inside the runner: the
 * scope bar is a client component and the runner is a `server-only` module
 * that reaches the Postgres client. Keeping these pure helpers here is what
 * lets the page, the CSV action, the client filter bar and the selftests all
 * agree on what `?offering=…&category=…` means without any of them importing
 * a database.
 */
import { isOfferingCategory, type OfferingCategory } from '@/lib/offerings/types';

/** What the report is scoped to. `all` is the default, unfiltered view. */
export type FunnelScope =
  | { type: 'all' }
  | { type: 'category'; category: OfferingCategory }
  | { type: 'offering'; offeringId: string }
  | { type: 'uncategorized' };

/**
 * Parse the scope out of URL params. Lives here rather than in the page so
 * the runner, the CSV action and the page cannot disagree about what
 * `?offering=…&category=…` means.
 *
 * Precedence: a specific offering wins over a category toggle, because the
 * dropdown is the narrower statement and leaving both applied would let the
 * two controls contradict each other (Service selected, a Product chosen)
 * into an always-empty result.
 *
 * An unrecognised value degrades to `all` rather than half-applying — the
 * same rule the deals filters follow, so a typo'd link shows the unfiltered
 * report instead of a plausible-looking wrong one.
 */
export function parseFunnelScope(params: {
  offering?: string | string[] | undefined;
  category?: string | string[] | undefined;
}): FunnelScope {
  const offering = typeof params.offering === 'string' ? params.offering.trim() : '';
  const category = typeof params.category === 'string' ? params.category.trim() : '';

  if (offering === 'uncategorized' || category === 'uncategorized') {
    return { type: 'uncategorized' };
  }
  if (UUID_RE.test(offering)) return { type: 'offering', offeringId: offering };
  if (isOfferingCategory(category)) return { type: 'category', category };
  return { type: 'all' };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serialize a scope back into URL params. Inverse of `parseFunnelScope`. */
export function funnelScopeToParams(scope: FunnelScope): {
  offering?: string;
  category?: string;
} {
  switch (scope.type) {
    case 'all':
      return {};
    case 'category':
      return { category: scope.category };
    case 'offering':
      return { offering: scope.offeringId };
    case 'uncategorized':
      return { category: 'uncategorized' };
  }
}
