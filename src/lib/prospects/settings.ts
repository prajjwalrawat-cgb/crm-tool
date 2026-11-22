import 'server-only';

import { eq } from 'drizzle-orm';

import { organizationSettings } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { MutationResult } from './mutations';
import { prospectSettingsSchema, type Actor, type ProspectSettingsInput } from './rules';

export { prospectSettingsSchema, type ProspectSettingsInput };

export type ProspectSettings = {
  claimDays: number;
  claimExpiryEnabled: boolean;
  autoParkDays: number;
  autoParkEnabled: boolean;
  enrichmentEnabled: boolean;
  aiSuggestionsEnabled: boolean;
};

export const PROSPECT_SETTING_DEFAULTS: ProspectSettings = {
  claimDays: 14,
  claimExpiryEnabled: true,
  autoParkDays: 45,
  autoParkEnabled: true,
  enrichmentEnabled: false,
  aiSuggestionsEnabled: false,
};


type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];

/** Reads inside the caller's transaction (claims use this). No row means the defaults. */
export async function getProspectSettingsTx(tx: Tx, tenantId: string): Promise<ProspectSettings> {
  const [r] = await tx
    .select({
      claimDays: organizationSettings.prospectClaimDays,
      claimExpiryEnabled: organizationSettings.prospectClaimExpiryEnabled,
      autoParkDays: organizationSettings.prospectAutoParkDays,
      autoParkEnabled: organizationSettings.prospectAutoParkEnabled,
      enrichmentEnabled: organizationSettings.prospectEnrichmentEnabled,
      aiSuggestionsEnabled: organizationSettings.aiSuggestionsEnabled,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);
  return r ?? { ...PROSPECT_SETTING_DEFAULTS };
}

export async function getProspectSettings(tenantId: string): Promise<ProspectSettings> {
  return tenantTransaction((tx) => getProspectSettingsTx(tx, tenantId));
}

/** Owner/admin only, the same rule as the AI suggestions settings. */
export async function updateProspectSettings(
  tenantId: string,
  actor: Actor,
  input: ProspectSettingsInput,
): Promise<MutationResult> {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return { ok: false, error: 'no_permission', message: 'Only owners and admins can change this.' };
  }
  const parsed = prospectSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check the settings and try again.' };
  const v = {
    prospectClaimDays: parsed.data.claimDays,
    prospectClaimExpiryEnabled: parsed.data.claimExpiryEnabled,
    prospectAutoParkDays: parsed.data.autoParkDays,
    prospectAutoParkEnabled: parsed.data.autoParkEnabled,
    prospectEnrichmentEnabled: parsed.data.enrichmentEnabled,
    updatedBy: actor.userId,
  };
  await tenantTransaction((tx) =>
    tx
      .insert(organizationSettings)
      .values({ tenantId, ...v })
      .onConflictDoUpdate({ target: organizationSettings.tenantId, set: v }),
  );
  return { ok: true };
}
