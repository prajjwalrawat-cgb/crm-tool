import { z } from 'zod';

import type { MembershipRole, Prospect, ProspectStage } from '@/db/schema';
import { normalizeCompanyName } from '@/lib/dedup/normalize';
import { normalizeEmail, normalizePhone } from '@/lib/lead-capture/normalize';
import { can } from '@/lib/rbac';

/**
 * Prospect Board rules: input validation/normalisation, the stage-move and
 * edit guards, URL filters and board grouping. Pure and client-safe: no
 * `server-only`, no runtime import from the db layer (types only).
 */

// Mirrors PROSPECT_STAGES / PROSPECT_SIZE_BANDS in db/schema/prospects.ts
// (redeclared so this module never pulls drizzle into a client bundle).
export const PROSPECT_STAGES = ['dump', 'researching', 'qualified', 'ready', 'parked'] as const satisfies readonly ProspectStage[];
export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
export const GROUP_BY_KEYS = ['industry', 'territory', 'product_fit', 'source_tag'] as const;
export type GroupByKey = (typeof GROUP_BY_KEYS)[number];

const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

/** Optional text: trimmed, '' / null / undefined become null. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const emptyToNull = (v: unknown) => (v === '' ? null : v);

const clusterTags = z
  .array(z.string())
  .nullish()
  .transform((arr, ctx) => {
    const out: string[] = [];
    for (const raw of arr ?? []) {
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      if (t.length > MAX_TAG_LEN) {
        ctx.addIssue({ code: 'custom', message: `Tag longer than ${MAX_TAG_LEN} characters` });
        return z.NEVER;
      }
      if (!out.includes(t)) out.push(t);
    }
    return out.slice(0, MAX_TAGS);
  });

export const prospectInputSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  domain: optText(200),
  contactName: optText(200),
  contactDesignation: optText(200),
  contactEmail: optText(320),
  contactPhone: optText(40),
  industry: optText(120),
  sizeBand: z.preprocess(emptyToNull, z.enum(SIZE_BANDS).nullish().transform((v) => v ?? null)),
  city: optText(120),
  state: optText(120),
  productFitOfferingId: z.preprocess(emptyToNull, z.string().uuid().nullish().transform((v) => v ?? null)),
  icpScore: z.preprocess(emptyToNull, z.number().int().min(0).max(100).nullish().transform((v) => v ?? null)),
  clusterTags,
  sourceTag: z.string().trim().min(1).max(80),
  notes: optText(5000),
});
export type ProspectInput = z.output<typeof prospectInputSchema>;

export type ProspectRowValues = ProspectInput & {
  normalizedName: string;
  emailNormalized: string | null;
  phoneNormalized: string | null;
};

/** Lower-case host without scheme, `www.`, path, query or port. */
function cleanDomain(raw: string | null): string | null {
  if (!raw) return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '');
  return host || null;
}

export function normalizeProspectInput(input: ProspectInput): ProspectRowValues {
  return {
    ...input,
    domain: cleanDomain(input.domain),
    normalizedName: normalizeCompanyName(input.companyName),
    emailNormalized: normalizeEmail(input.contactEmail),
    phoneNormalized: normalizePhone(input.contactPhone),
  };
}

/* ---------------- guards ---------------- */

export type Actor = { userId: string; role: MembershipRole };

export const isManagerRole = (role: MembershipRole): boolean =>
  role === 'owner' || role === 'admin' || role === 'manager';

export type GuardRow = Pick<Prospect, 'claimedBy' | 'claimExpiresAt' | 'promotedDealId' | 'deletedAt' | 'stage'>;

export function stageMoveBlock(
  p: GuardRow,
  to: ProspectStage,
  actor: Actor,
  now: Date = new Date(),
): null | 'promoted' | 'deleted' | 'claimed_by_other' | 'same_stage' | 'no_permission' {
  if (!can(actor.role, 'manageProspects')) return 'no_permission';
  if (p.deletedAt) return 'deleted';
  if (p.promotedDealId) return 'promoted';
  if (p.stage === to) return 'same_stage';
  if (isClaimActive(p, now) && p.claimedBy !== actor.userId && !isManagerRole(actor.role)) return 'claimed_by_other';
  return null;
}

/** A claim is active while claimed and not yet expired (claimExpiresAt <= now counts as unclaimed). */
export function isClaimActive(
  p: { claimedBy: string | null; claimExpiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!p.claimedBy) return false;
  return !(p.claimExpiresAt != null && new Date(p.claimExpiresAt).getTime() <= now.getTime());
}

/** Claiming your own active claim is allowed (it extends the lock). */
export function claimBlock(
  p: GuardRow,
  actor: Actor,
  now: Date = new Date(),
): null | 'no_permission' | 'deleted' | 'promoted' | 'claimed_by_other' {
  if (!can(actor.role, 'manageProspects')) return 'no_permission';
  if (p.deletedAt) return 'deleted';
  if (p.promotedDealId) return 'promoted';
  if (isClaimActive(p, now) && p.claimedBy !== actor.userId) return 'claimed_by_other';
  return null;
}

/** A manager may release anyone's claim. */
export function releaseBlock(
  p: GuardRow,
  actor: Actor,
  now: Date = new Date(),
): null | 'no_permission' | 'deleted' | 'promoted' | 'not_claimed' | 'claimed_by_other' {
  if (!can(actor.role, 'manageProspects')) return 'no_permission';
  if (p.deletedAt) return 'deleted';
  if (p.promotedDealId) return 'promoted';
  if (!isClaimActive(p, now)) return 'not_claimed';
  if (p.claimedBy !== actor.userId && !can(actor.role, 'manageProspectClaims')) return 'claimed_by_other';
  return null;
}

/** A claim never locks fields: anyone who can manage prospects may edit. */
export function editBlock(
  p: Pick<Prospect, 'promotedDealId' | 'deletedAt'>,
  actor: Actor,
): null | 'promoted' | 'deleted' | 'no_permission' {
  if (!can(actor.role, 'manageProspects')) return 'no_permission';
  if (p.deletedAt) return 'deleted';
  if (p.promotedDealId) return 'promoted';
  return null;
}

/* ---------------- filters ---------------- */

export type ProspectFilters = {
  mine?: boolean;
  unclaimed?: boolean;
  source?: string;
  stage?: ProspectStage;
  q?: string;
  showPromoted?: boolean;
  groupBy?: GroupByKey;
};

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isOn = (v: string | undefined) => v === '1' || v === 'true';

export function parseProspectFilters(sp: Record<string, string | string[] | undefined>): ProspectFilters {
  const out: ProspectFilters = {};
  if (isOn(first(sp.mine))) out.mine = true;
  if (isOn(first(sp.unclaimed))) out.unclaimed = true;
  const source = first(sp.source)?.trim();
  if (source) out.source = source.slice(0, 80);
  const stage = first(sp.stage);
  if ((PROSPECT_STAGES as readonly string[]).includes(stage ?? '')) out.stage = stage as ProspectStage;
  const q = first(sp.q)?.trim();
  if (q) out.q = q.slice(0, 200);
  if (isOn(first(sp.showPromoted))) out.showPromoted = true;
  const groupBy = first(sp.groupBy);
  if ((GROUP_BY_KEYS as readonly string[]).includes(groupBy ?? '')) out.groupBy = groupBy as GroupByKey;
  return out;
}

/* ---------------- board grouping ---------------- */

export type ProspectCard = {
  id: string;
  companyName: string;
  contactName: string | null;
  contactEmail: string | null;
  sourceTag: string;
  clusterTags: string[];
  industry: string | null;
  city: string | null;
  state: string | null;
  sizeBand: string | null;
  productFitOfferingId: string | null;
  productFitName: string | null;
  icpScore: number | null;
  stage: ProspectStage;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  votesKnowSomeone: number;
  votesPriority: number;
  promotedDealId: string | null;
  lastActivityAt: Date;
};

const NONE = { key: '__none', label: 'None' } as const;

/** Key by trimmed lowercase; label is this card's trimmed spelling (callers keep the first-seen lane label). */
function caseInsensitiveLane(value: string | null): { key: string; label: string } {
  const label = value?.trim();
  return label ? { key: label.toLowerCase(), label } : NONE;
}

export function groupKeyOf(card: ProspectCard, by: GroupByKey): { key: string; label: string } {
  switch (by) {
    case 'industry':
      return caseInsensitiveLane(card.industry);
    case 'source_tag':
      return caseInsensitiveLane(card.sourceTag);
    case 'product_fit':
      return card.productFitOfferingId
        ? { key: card.productFitOfferingId, label: card.productFitName ?? 'Unknown offering' }
        : NONE;
    case 'territory': {
      const label = [card.state, card.city].filter(Boolean).join(' · ');
      return label ? { key: label, label } : NONE;
    }
  }
}
