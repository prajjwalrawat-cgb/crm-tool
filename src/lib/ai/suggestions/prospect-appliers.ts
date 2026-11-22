import 'server-only';

import type { ProspectInput } from '@/lib/prospects/rules';
import { updateProspect } from '@/lib/prospects/mutations';

import type { ApplyContext, ApplyResult, Appliers } from './service';

/**
 * Accepting a prospect enrichment suggestion: the same `updateProspect` a
 * manual edit goes through, as the accepting user, so the read-only rules
 * (promoted / deleted), the manageProspects permission and the offering
 * ownership check all apply, and `last_activity_at` is bumped. Nothing here
 * writes a prospect column directly. Kept apart from appliers.ts (which pulls
 * in session-bound server actions) so the DB selftest can use the real thing.
 */
function viaUpdateProspect(patch: (value: ApplyContext['value']) => Partial<ProspectInput>) {
  return async ({ tenantId, userId, role, suggestion, value }: ApplyContext): Promise<ApplyResult> => {
    const r = await updateProspect(tenantId, { userId, role }, suggestion.entityId, patch(value));
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  };
}

export const prospectAppliers: Pick<Appliers, 'industry' | 'size_band' | 'product_fit' | 'icp_score'> = {
  industry: viaUpdateProspect((v) => ({ industry: String(v) })),
  size_band: viaUpdateProspect((v) => ({ sizeBand: String(v) as ProspectInput['sizeBand'] })),
  product_fit: viaUpdateProspect((v) => ({ productFitOfferingId: String(v) })),
  icp_score: viaUpdateProspect((v) => ({ icpScore: Number(v) })),
};
