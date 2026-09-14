import 'server-only';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import { dealOfferings, deals, offerings, type Offering } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { isFeatureEnabled } from '@/lib/workspace-settings/queries';

import {
  type DealOfferingRow,
  defaultPrimary,
  OFFERING_PRIMARY_REQUIRED_MESSAGE,
  OFFERINGS_CANNOT_EMPTY_MESSAGE,
  type OfferingCategory,
  type OfferingOption,
} from './types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Is the Offerings feature switched on for this workspace (0067)?
 *
 * EVERY Offerings surface must ask this, server-side, before it renders,
 * requires or writes anything — the picker, the mandatory create rule, the
 * edit-drawer sync, the list column and filters, the detail card and its
 * actions, the report, the export columns. OFF means invisible AND inert.
 *
 * The one deliberate exception is the Settings catalog itself: an admin can
 * shape the catalog while the feature is off, so a workspace can replace the
 * seeded list with its own portfolio BEFORE the mandatory picker goes live
 * for its reps, rather than after.
 *
 * Nothing here deletes data when the flag is off. Tags and catalog rows stay,
 * and switching it back on restores them exactly.
 */
export async function isOfferingsEnabled(tenantId: string): Promise<boolean> {
  return isFeatureEnabled(tenantId, 'offeringsEnabled');
}

/**
 * The portfolio this deployment ships with, mirroring the seed block in
 * migration 0066 so a workspace created AFTER the migration ran still gets a
 * catalog. Kept in both places on purpose: the migration cannot import
 * TypeScript, and `createTenant` must not depend on a migration having been
 * re-run. If the two ever disagree the migration wins for existing tenants
 * and this wins for new ones — so change them together.
 *
 * `sortOrder` is spaced by 10 so a later inline add can land between two
 * entries without renumbering the category.
 */
export const DEFAULT_OFFERINGS: ReadonlyArray<{
  name: string;
  category: OfferingCategory;
  sortOrder: number;
}> = [
  { name: 'SafeOps360', category: 'product', sortOrder: 10 },
  { name: 'Expenses Tool', category: 'product', sortOrder: 20 },
  { name: 'CRM (Saleinx)', category: 'product', sortOrder: 30 },
  { name: 'AnytimeHire', category: 'product', sortOrder: 40 },
  { name: 'ProcureFlow', category: 'product', sortOrder: 50 },
  { name: 'VisitOS', category: 'product', sortOrder: 60 },
  { name: 'Cadence', category: 'product', sortOrder: 70 },
  { name: 'LUMINEX', category: 'product', sortOrder: 80 },
  { name: 'Velantis', category: 'product', sortOrder: 90 },
  { name: 'Recruitment', category: 'service', sortOrder: 10 },
  { name: 'Contract Manpower', category: 'service', sortOrder: 20 },
  { name: 'Implementation Services', category: 'service', sortOrder: 30 },
  { name: 'DC Support', category: 'service', sortOrder: 40 },
  { name: 'Infra Support', category: 'service', sortOrder: 50 },
];

/** Catalog order, used by every list: category, then sort_order, then name. */
const CATALOG_ORDER = [
  asc(offerings.category),
  asc(offerings.sortOrder),
  asc(offerings.name),
];

/* ------------------------------------------------------------------ *
 * Catalog reads                                                       *
 * ------------------------------------------------------------------ */

export type OfferingWithUsage = Offering & {
  /**
   * How many non-deleted deals carry this offering. Shown in Settings so an
   * admin can see what a deactivation will affect before doing it — and so
   * the page can explain why nothing here offers a Delete button.
   */
  dealCount: number;
};

/**
 * Every offering in the workspace, active and retired, with usage counts.
 * Settings needs the retired ones — they're what the Reactivate button acts
 * on, and hiding them would make a retired offering unrecoverable from the UI.
 */
export async function listOfferingsWithUsage(
  tenantId: string,
): Promise<OfferingWithUsage[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: offerings.id,
        tenantId: offerings.tenantId,
        name: offerings.name,
        category: offerings.category,
        active: offerings.active,
        sortOrder: offerings.sortOrder,
        createdAt: offerings.createdAt,
        updatedAt: offerings.updatedAt,
        // Correlated count rather than a GROUP BY join: the catalog is
        // dozens of rows, so this is dozens of index probes on
        // deal_offerings_tenant_offering_idx, and it keeps offerings with
        // zero deals in the result without a LEFT JOIN + COALESCE dance.
        //
        // The outer columns are reached through the TABLE (`${offerings}.id`)
        // rather than as column references. Drizzle renders a column inside a
        // `.select()` projection UNQUALIFIED, so `${offerings.id}` emits a
        // bare `"id"` that Postgres resolves against the SUBQUERY's scope —
        // silently comparing deal_offerings to itself instead of correlating.
        dealCount: sql<number>`(
          SELECT count(*)::int FROM ${dealOfferings} dof
          JOIN ${deals} d ON d.id = dof.deal_id AND d.deleted_at IS NULL
          WHERE dof.tenant_id = ${offerings}.tenant_id
            AND dof.offering_id = ${offerings}.id
        )`,
      })
      .from(offerings)
      .where(eq(offerings.tenantId, tenantId))
      .orderBy(...CATALOG_ORDER),
  );
  return rows.map((r) => ({ ...r, dealCount: Number(r.dealCount) }));
}

/**
 * The tag picker's source. `activeOnly` is the default and is the whole
 * point of the `active` flag: a retired offering must stay readable on the
 * deals that already carry it while being untaggable onto new ones.
 *
 * The deal detail card passes `activeOnly: false` for its DISPLAY list only —
 * never for the add-a-tag dropdown.
 */
export async function listOfferingOptions(
  tenantId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<OfferingOption[]> {
  const activeOnly = opts.activeOnly ?? true;
  const where = activeOnly
    ? and(eq(offerings.tenantId, tenantId), eq(offerings.active, true))
    : eq(offerings.tenantId, tenantId);
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        id: offerings.id,
        name: offerings.name,
        category: offerings.category,
        active: offerings.active,
      })
      .from(offerings)
      .where(where)
      .orderBy(...CATALOG_ORDER),
  );
}

/* ------------------------------------------------------------------ *
 * Catalog writes                                                      *
 * ------------------------------------------------------------------ */

export class DuplicateOfferingError extends Error {}

/** Postgres 23505 on either of the 0066 unique indexes. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return (
    cause?.code === '23505' ||
    /duplicate key|unique constraint/i.test(`${msg} ${cause?.message ?? ''}`)
  );
}

export async function createOffering(input: {
  tenantId: string;
  name: string;
  category: OfferingCategory;
}): Promise<Offering> {
  // New entries land at the end of their category. Reading the current max
  // inside the same transaction as the insert keeps two admins adding at
  // once from colliding on one number — and even if they do, `sortOrder`
  // ties break by name (see `compareOfferings`), so the list stays stable.
  try {
    const [row] = await tenantTransaction(async (tx) => {
      const [max] = await tx
        .select({
          value: sql<number>`coalesce(max(${offerings.sortOrder}), 0)::int`,
        })
        .from(offerings)
        .where(
          and(
            eq(offerings.tenantId, input.tenantId),
            eq(offerings.category, input.category),
          ),
        );
      return tx
        .insert(offerings)
        .values({
          tenantId: input.tenantId,
          name: input.name,
          category: input.category,
          sortOrder: Number(max?.value ?? 0) + 10,
        })
        .returning();
    });
    if (!row) throw new Error('offering insert returned no row');
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateOfferingError(
        `“${input.name}” already exists in this workspace.`,
      );
    }
    throw err;
  }
}

/**
 * Rename and/or recategorise. Moving a Product to Service is allowed and
 * intentionally does NOT touch the deals already tagged with it: the deal is
 * selling the same thing, and rewriting history because a taxonomy was
 * corrected would be the worse surprise. Every funnel simply reads the new
 * category from the next query onward.
 */
export async function updateOffering(input: {
  tenantId: string;
  id: string;
  name: string;
  category: OfferingCategory;
}): Promise<Offering | null> {
  try {
    const [row] = await tenantTransaction(async (tx) =>
      tx
        .update(offerings)
        .set({
          name: input.name,
          category: input.category,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(offerings.id, input.id),
            eq(offerings.tenantId, input.tenantId),
          ),
        )
        .returning(),
    );
    return row ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateOfferingError(
        `“${input.name}” already exists in this workspace.`,
      );
    }
    throw err;
  }
}

/**
 * Retire (or bring back) an offering. This is the ONLY removal path — there
 * is no delete anywhere in this module, and the FK refuses to orphan a tag
 * so nothing else can invent one.
 */
export async function setOfferingActive(
  tenantId: string,
  id: string,
  active: boolean,
): Promise<Offering | null> {
  const [row] = await tenantTransaction(async (tx) =>
    tx
      .update(offerings)
      .set({ active, updatedAt: new Date() })
      .where(and(eq(offerings.id, id), eq(offerings.tenantId, tenantId)))
      .returning(),
  );
  return row ?? null;
}

/**
 * Rewrite one category's ordering from an explicit id list. The caller (the
 * Settings page's up/down buttons) computes the new order client-side and
 * sends the whole list.
 *
 * Whole-list rather than swap-two-rows: a swap has to read both neighbours,
 * and if the page's idea of "the row below" is stale — another admin
 * reordered, or a row was deactivated — a swap silently moves the wrong pair.
 * Rewriting from the list the admin was actually looking at either applies
 * exactly what they saw or, when an id no longer belongs to the category, is
 * ignored for that id.
 *
 * Ids are re-spaced by 10 on every write, which also repairs any duplicate
 * `sort_order` values left by concurrent inline adds.
 */
export async function reorderOfferings(
  tenantId: string,
  category: OfferingCategory,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length === 0) return;
  await tenantTransaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(offerings)
        .set({ sortOrder: (i + 1) * 10, updatedAt: new Date() })
        .where(
          and(
            eq(offerings.id, orderedIds[i]!),
            eq(offerings.tenantId, tenantId),
            eq(offerings.category, category),
          ),
        );
    }
  });
}

/**
 * Give a workspace the default catalog. Called for newly created tenants —
 * migration 0066 seeds the ones that already existed.
 *
 * `onConflictDoNothing` makes it idempotent and, more usefully, safe to call
 * against a workspace whose admin has already edited the list: it adds what
 * is missing by name and never resurrects or overwrites anything.
 */
export async function seedDefaultOfferings(tenantId: string): Promise<void> {
  await tenantTransaction(async (tx) => {
    await tx
      .insert(offerings)
      .values(
        DEFAULT_OFFERINGS.map((o) => ({
          tenantId,
          name: o.name,
          category: o.category,
          sortOrder: o.sortOrder,
        })),
      )
      .onConflictDoNothing();
  });
}

/* ------------------------------------------------------------------ *
 * Per-deal tags                                                       *
 * ------------------------------------------------------------------ */

/**
 * Every offering on one deal, primary first then catalog order. Retired
 * offerings are included — that is the promise the `active` flag makes.
 */
export async function listDealOfferings(
  tenantId: string,
  dealId: string,
): Promise<DealOfferingRow[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        linkId: dealOfferings.id,
        id: offerings.id,
        name: offerings.name,
        category: offerings.category,
        active: offerings.active,
        isPrimary: dealOfferings.isPrimary,
      })
      .from(dealOfferings)
      .innerJoin(offerings, eq(dealOfferings.offeringId, offerings.id))
      .where(
        and(
          eq(dealOfferings.tenantId, tenantId),
          eq(dealOfferings.dealId, dealId),
        ),
      )
      .orderBy(sql`${dealOfferings.isPrimary} DESC`, ...CATALOG_ORDER),
  );
}

/**
 * Narrow a caller-supplied id list to offerings that really exist in this
 * tenant, and (for new tagging) are still active. Returns the ids in catalog
 * order so the "first tag becomes primary" default is deterministic rather
 * than dependent on however the form serialised its checkboxes.
 *
 * RLS already masks other tenants' rows, so this is not the security
 * boundary — it is the difference between a clear "that offering is no
 * longer available" and a raw FK error.
 */
export async function resolveOfferingIds(
  tx: Tx,
  tenantId: string,
  ids: string[],
  opts: { activeOnly?: boolean } = {},
): Promise<string[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const conditions = [
    eq(offerings.tenantId, tenantId),
    inArray(offerings.id, unique),
  ];
  if (opts.activeOnly ?? true) conditions.push(eq(offerings.active, true));
  const rows = await tx
    .select({ id: offerings.id })
    .from(offerings)
    .where(and(...conditions))
    .orderBy(...CATALOG_ORDER);
  return rows.map((r) => r.id);
}

/**
 * Write a brand-new deal's tags, inside the caller's transaction so a deal
 * and its offerings land together or not at all. A deal that committed
 * without its tags would be exactly the untagged legacy row this feature
 * exists to stop creating.
 *
 * Assumes `offeringIds` has already been through `resolveOfferingIds`.
 */
export async function insertDealOfferings(
  tx: Tx,
  input: {
    tenantId: string;
    dealId: string;
    offeringIds: string[];
    primaryOfferingId: string | null;
  },
): Promise<void> {
  if (input.offeringIds.length === 0) return;
  const primary = defaultPrimary(input.offeringIds, input.primaryOfferingId);
  await tx.insert(dealOfferings).values(
    input.offeringIds.map((offeringId) => ({
      tenantId: input.tenantId,
      dealId: input.dealId,
      offeringId,
      isPrimary: offeringId === primary,
    })),
  );
}

export class OfferingSyncError extends Error {}

/**
 * Reconcile a deal's tags to exactly `offeringIds`, inside the caller's
 * transaction. Used by the edit drawer, which submits the whole selection
 * rather than individual add/remove operations.
 *
 * Three rules live here rather than at the call site, because the detail
 * card's per-tag actions have to agree with them:
 *
 * 1. A RETIRED offering ALREADY on the deal may stay. Only genuinely NEW
 *    additions are required to be active. Running every submitted id through
 *    the active-only filter — the obvious implementation — would silently
 *    untag a retired offering the moment anyone saved an unrelated field on
 *    that deal, quietly rewriting the history the `active` flag exists to
 *    preserve.
 *
 * 2. A deal that HAS tags may not be emptied (the 'keep' rule). Enforced here
 *    as well as in the form because the form check is a courtesy and this is
 *    the rule — and because this is the path a stale tab or a replayed
 *    request would take.
 *
 * 3. An untagged deal stays untagged without complaint. That is the legacy
 *    backlog, and blocking it would make every old deal unsavable.
 *
 * Writes nothing when the selection already matches, so saving an unrelated
 * field doesn't churn tag rows (or their created_at ordering).
 */
export async function syncDealOfferings(
  tx: Tx,
  input: {
    tenantId: string;
    dealId: string;
    offeringIds: string[];
    primaryOfferingId: string | null;
  },
): Promise<void> {
  const current = await tx
    .select({
      id: dealOfferings.id,
      offeringId: dealOfferings.offeringId,
      isPrimary: dealOfferings.isPrimary,
    })
    .from(dealOfferings)
    .where(
      and(
        eq(dealOfferings.tenantId, input.tenantId),
        eq(dealOfferings.dealId, input.dealId),
      ),
    );

  const currentIds = new Set(current.map((r) => r.offeringId));
  const requested = Array.from(new Set(input.offeringIds.filter(Boolean)));

  // Rule 1: keeps bypass the active check, additions don't.
  const keeps = requested.filter((id) => currentIds.has(id));
  const additionsRequested = requested.filter((id) => !currentIds.has(id));
  const additions =
    additionsRequested.length > 0
      ? await resolveOfferingIds(tx, input.tenantId, additionsRequested, {
          activeOnly: true,
        })
      : [];
  if (additions.length !== additionsRequested.length) {
    throw new OfferingSyncError(
      'One of those offerings is no longer available. Reopen the deal and pick again.',
    );
  }

  const finalIds = [...keeps, ...additions];

  // Rules 2 and 3.
  if (finalIds.length === 0) {
    if (currentIds.size > 0) {
      throw new OfferingSyncError(OFFERINGS_CANNOT_EMPTY_MESSAGE);
    }
    return; // untagged before, untagged now — nothing to do, nothing to say
  }

  const removals = current.filter((r) => !finalIds.includes(r.offeringId));
  if (removals.length > 0) {
    await tx.delete(dealOfferings).where(
      and(
        eq(dealOfferings.tenantId, input.tenantId),
        eq(dealOfferings.dealId, input.dealId),
        inArray(
          dealOfferings.offeringId,
          removals.map((r) => r.offeringId),
        ),
      ),
    );
  }

  const primary = defaultPrimary(finalIds, input.primaryOfferingId);
  if (!primary) {
    throw new OfferingSyncError(OFFERING_PRIMARY_REQUIRED_MESSAGE);
  }

  // Clear before setting, always: the partial unique index on
  // (deal_id) WHERE is_primary rejects the moment a second `true` exists, so
  // set-then-clear fails on every deal that already has a primary.
  await clearDealPrimary(tx, input.tenantId, input.dealId);

  if (additions.length > 0) {
    await tx.insert(dealOfferings).values(
      additions.map((offeringId) => ({
        tenantId: input.tenantId,
        dealId: input.dealId,
        offeringId,
        isPrimary: offeringId === primary,
      })),
    );
  }
  // A kept row may need the flag moved onto it; the insert above already
  // carries it for a newly added primary.
  if (keeps.includes(primary)) {
    await tx
      .update(dealOfferings)
      .set({ isPrimary: true })
      .where(
        and(
          eq(dealOfferings.tenantId, input.tenantId),
          eq(dealOfferings.dealId, input.dealId),
          eq(dealOfferings.offeringId, primary),
        ),
      );
  }
}

/**
 * Clear whatever primary the deal currently has. Every "make this one
 * primary" path calls this FIRST, in the same transaction, because the
 * partial unique index on `(deal_id) WHERE is_primary` rejects the moment a
 * second true exists — even transiently within a statement.
 */
export async function clearDealPrimary(
  tx: Tx,
  tenantId: string,
  dealId: string,
): Promise<void> {
  await tx
    .update(dealOfferings)
    .set({ isPrimary: false })
    .where(
      and(
        eq(dealOfferings.tenantId, tenantId),
        eq(dealOfferings.dealId, dealId),
        eq(dealOfferings.isPrimary, true),
      ),
    );
}

/** Count the deal's existing tags — the "first tag is automatically primary" test. */
export async function countDealOfferings(
  tx: Tx,
  tenantId: string,
  dealId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(dealOfferings)
    .where(
      and(
        eq(dealOfferings.tenantId, tenantId),
        eq(dealOfferings.dealId, dealId),
      ),
    );
  return Number(row?.n ?? 0);
}
