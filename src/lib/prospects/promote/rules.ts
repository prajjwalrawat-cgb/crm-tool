import { can } from '@/lib/rbac';

import { isClaimActive, isManagerRole, type Actor, type GuardRow } from '../rules';

/** Promote guards and candidate shape. Pure and client-safe. */

export type PromoteBlock =
  | 'no_permission'
  | 'deleted'
  | 'promoted'
  | 'parked'
  | 'missing_contact'
  | 'claimed_by_other'
  | 'out_of_scope';

export type PromoteRow = GuardRow & { companyName: string; emailNormalized: string | null; phoneNormalized: string | null };

/**
 * `holderInScope`: the claim holder is within the caller's team scope
 * (only consulted for a manager promoting someone else's active claim).
 */
export function promoteBlock(
  p: PromoteRow,
  actor: Actor,
  opts: { holderInScope: boolean },
  now: Date = new Date(),
): null | PromoteBlock {
  if (!can(actor.role, 'promoteProspects')) return 'no_permission';
  if (p.deletedAt) return 'deleted';
  if (p.promotedDealId) return 'promoted';
  if (p.stage === 'parked') return 'parked';
  if (!p.companyName.trim() || (!p.emailNormalized && !p.phoneNormalized)) return 'missing_contact';
  if (isClaimActive(p, now) && p.claimedBy !== actor.userId) {
    if (actor.role === 'owner' || actor.role === 'admin') return null;
    if (!isManagerRole(actor.role) || !can(actor.role, 'manageProspectClaims')) return 'claimed_by_other';
    if (!opts.holderInScope) return 'out_of_scope';
  }
  return null;
}

export type MatchCandidate = {
  kind: 'company' | 'contact' | 'open_lead';
  id: string;
  label: string;
  sublabel: string | null;
  strength: 'strong' | 'weak';
  reason: 'name' | 'domain' | 'email' | 'phone' | 'fuzzy_name' | 'open_lead';
};
