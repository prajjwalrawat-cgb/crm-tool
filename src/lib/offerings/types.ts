/**
 * Client-safe offering vocabulary — labels, colours, grouping and the one
 * validation rule the create form and the server action must agree on.
 *
 * Deliberately free of `server-only` (and of any `@/db` import) so the
 * create form, the deals table and the report filter bar can all render an
 * offering without pulling the Postgres client into the browser bundle. The
 * queries live next door in `queries.ts`.
 */

export const OFFERING_CATEGORIES = ['product', 'service'] as const;

export type OfferingCategory = (typeof OFFERING_CATEGORIES)[number];

export const OFFERING_CATEGORY_LABELS: Record<OfferingCategory, string> = {
  product: 'Product',
  service: 'Service',
};

/** Plural form, for the grouped headings in the picker and Settings. */
export const OFFERING_CATEGORY_PLURAL: Record<OfferingCategory, string> = {
  product: 'Products',
  service: 'Services',
};

/**
 * What a deal with no tags reads as, everywhere. One constant rather than
 * three hand-typed strings: the deals column, the filter chip and the
 * funnel's coverage row are the same fact and must not drift apart.
 */
export const UNCATEGORIZED_LABEL = 'Uncategorized';

/**
 * Category colour-coding. Product = indigo (the app's primary accent, since
 * products are the default lens), Service = teal — far enough apart in hue
 * to survive the 10px chip size, and neither one reused by the stage badges
 * (slate / amber / emerald / rose), so an Offering chip can never be
 * misread as a stage at a glance.
 */
export const OFFERING_CATEGORY_CHIP: Record<OfferingCategory, string> = {
  product:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300',
  service:
    'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300',
};

/** The muted treatment for an untagged deal — a gap, not a value. */
export const UNCATEGORIZED_CHIP =
  'border-dashed border-slate-200 bg-slate-50 text-slate-400 dark:border-[#2A2A2A] dark:bg-[#161616] dark:text-[#71717A]';

export function isOfferingCategory(v: string): v is OfferingCategory {
  return (OFFERING_CATEGORIES as readonly string[]).includes(v);
}

/** The picker / chip shape. Everything the UI needs, nothing it doesn't. */
export type OfferingOption = {
  id: string;
  name: string;
  category: OfferingCategory;
  active: boolean;
};

/**
 * One offering tagged on a deal, as the LIST and the edit drawer see it.
 * No `deal_offerings` row id: list consumers address tags by offering id
 * (that is what the pickers hold), and only the detail card needs the link
 * row itself.
 */
export type DealOfferingTag = OfferingOption & {
  isPrimary: boolean;
};

/** A tag as the DETAIL card sees it — plus the join-row id its actions take. */
export type DealOfferingRow = DealOfferingTag & {
  /** The `deal_offerings` row id — what the remove / set-primary actions take. */
  linkId: string;
};

/**
 * The tag that labels the deal. Returns null for an untagged deal, which is
 * the "Uncategorized" state.
 *
 * Derived from the array rather than carried as its own column, so the chip
 * the table renders and the tags the drawer edits are guaranteed to be the
 * same fact. They were separate fields once and could drift by exactly one
 * stale join.
 */
export function primaryOfferingOf(
  tags: readonly DealOfferingTag[],
): DealOfferingTag | null {
  return tags.find((t) => t.isPrimary) ?? null;
}

/**
 * Group offerings for the `<optgroup>`-style rendering both the picker and
 * the Settings list use. Categories always come back in
 * `OFFERING_CATEGORIES` order, and an empty category is still returned —
 * "no Services yet" is information the admin needs, and a disappearing
 * heading makes the page look broken rather than empty.
 */
export function groupByCategory<T extends { category: OfferingCategory }>(
  items: T[],
): Array<{ category: OfferingCategory; items: T[] }> {
  return OFFERING_CATEGORIES.map((category) => ({
    category,
    items: items.filter((i) => i.category === category),
  }));
}

/**
 * Catalog display order: category first, then `sortOrder`, then name.
 *
 * Name is the final tiebreak rather than insertion order because the seed
 * ships every row in a category with spaced-by-10 `sort_order` values but a
 * later inline add gets whatever the admin left it at — often the same
 * number as another row. Without a deterministic tiebreak those two rows
 * would swap places between renders, which reads as a bug in the reorder
 * buttons.
 */
export function compareOfferings(
  a: { category: OfferingCategory; sortOrder: number; name: string },
  b: { category: OfferingCategory; sortOrder: number; name: string },
): number {
  if (a.category !== b.category) {
    return (
      OFFERING_CATEGORIES.indexOf(a.category) -
      OFFERING_CATEGORIES.indexOf(b.category)
    );
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

/* ------------------------------------------------------------------ *
 * The mandatory-on-create rule                                        *
 * ------------------------------------------------------------------ */

export const OFFERINGS_REQUIRED_MESSAGE =
  'Pick at least one offering — what is this deal selling?';

export const OFFERING_PRIMARY_REQUIRED_MESSAGE =
  'Mark one offering as primary.';

export const OFFERINGS_CANNOT_EMPTY_MESSAGE =
  'This deal is already tagged, so it can’t be left with no offering. To change what it sells, add the right one first, then remove this.';

/**
 * Which offering rule a given save is subject to.
 *
 *   'required' — a NEW deal. Must carry at least one offering.
 *   'keep'     — an EXISTING deal that already carries tags. May be
 *                re-tagged freely, but may not be emptied.
 *   undefined  — an existing deal with NO tags: the legacy backlog. Never
 *                blocked, so an untagged deal stays fully editable.
 *
 * WHY 'keep' EXISTS, since it is easy to mistake for redundant strictness.
 * The first cut of this feature keyed the rule on create-vs-update, and that
 * proxy leaked: a deal created under the mandatory rule could be opened
 * straight afterwards and stripped of every tag, landing in the exact
 * "untagged" state creation had just refused to produce. The requirement is
 * not really about which action is running, it is about the deal's history —
 * a deal that has never been tagged is grandfathered, a deal that HAS been
 * tagged must not regress. `offeringRuleFor` derives that from the tag count,
 * so both the create form and the edit paths read it from one place.
 *
 * This does not trap a mistagged deal, which was the original (wrong) reason
 * for allowing removal down to zero: the fix for a wrong tag is to add the
 * right one and then remove the wrong one, and the message says so.
 */
export type OfferingRule = 'required' | 'keep' | undefined;

export function offeringRuleFor(input: {
  isNewDeal: boolean;
  existingTagCount: number;
}): OfferingRule {
  if (input.isNewDeal) return 'required';
  return input.existingTagCount > 0 ? 'keep' : undefined;
}

/** The message a rule shows when the selection comes back empty. */
export function emptyOfferingMessage(rule: OfferingRule): string {
  return rule === 'keep'
    ? OFFERINGS_CANNOT_EMPTY_MESSAGE
    : OFFERINGS_REQUIRED_MESSAGE;
}

/**
 * The create-form rule, in one place so the client pre-check and the server
 * action cannot disagree about what "tagged" means.
 *
 * Two rules, and the asymmetry is the design:
 *   1. At least one offering. Enforced ONLY on create — see below.
 *   2. If more than one is tagged, exactly one must be primary. With a
 *      single tag the caller is expected to have defaulted it to primary
 *      (`defaultPrimary` does that), so a lone untagged-primary selection is
 *      a caller bug, not a user error, and is normalised rather than
 *      rejected.
 *
 * WHY CREATE ONLY. Every deal that predates 0066 is untagged, and there is
 * no backfill. If this rule also ran on update, the first person to edit a
 * legacy deal's close date would be blocked by a field they didn't touch and
 * may not know the answer to — which is how a governance rule becomes a
 * reason to avoid the CRM. New deals are born tagged; old ones get tagged
 * when someone knows the answer.
 */
export function validateOfferingSelection(selection: {
  offeringIds: string[];
  primaryOfferingId: string | null;
}): { ok: true; primaryOfferingId: string } | { ok: false; message: string } {
  const ids = dedupe(selection.offeringIds);
  if (ids.length === 0) {
    return { ok: false, message: OFFERINGS_REQUIRED_MESSAGE };
  }
  const primary = defaultPrimary(ids, selection.primaryOfferingId);
  if (!primary) {
    return { ok: false, message: OFFERING_PRIMARY_REQUIRED_MESSAGE };
  }
  return { ok: true, primaryOfferingId: primary };
}

/**
 * Resolve which tag is primary: the requested one when it is actually in the
 * selection, otherwise the first tag when there is only one (the spec's
 * auto-default), otherwise nothing — which the caller turns into "pick one".
 *
 * The `ids.includes(requested)` guard matters: the form can hold a primary
 * choice, then have that offering unticked. Trusting the stale value would
 * write a primary flag onto a row that is never inserted, leaving the deal
 * with tags and no primary.
 */
export function defaultPrimary(
  offeringIds: string[],
  requested: string | null | undefined,
): string | null {
  const ids = dedupe(offeringIds);
  if (ids.length === 0) return null;
  if (requested && ids.includes(requested)) return requested;
  if (ids.length === 1) return ids[0]!;
  return null;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => id.trim().length > 0)));
}
