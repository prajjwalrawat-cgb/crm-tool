import 'server-only';

import { eq } from 'drizzle-orm';

import { organizationSettings } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { MutationResult } from './mutations';
import { PROSPECT_SOURCES, prospectSettingsSchema, prospectSourcesSchema, type Actor, type ProspectSettingsInput } from './rules';

export { prospectSettingsSchema, type ProspectSettingsInput };

export type ProspectSettings = {
  claimDays: number;
  claimExpiryEnabled: boolean;
  autoParkDays: number;
  autoParkEnabled: boolean;
  enrichmentEnabled: boolean;
  aiSuggestionsEnabled: boolean;
  /** The Source dropdown choices for new prospects. */
  sources: string[];
};

export const PROSPECT_SETTING_DEFAULTS: ProspectSettings = {
  claimDays: 14,
  claimExpiryEnabled: true,
  autoParkDays: 45,
  autoParkEnabled: true,
  enrichmentEnabled: false,
  aiSuggestionsEnabled: false,
  sources: [...PROSPECT_SOURCES],
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
      sources: organizationSettings.prospectSources,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);
  if (!r) return { ...PROSPECT_SETTING_DEFAULTS, sources: [...PROSPECT_SETTING_DEFAULTS.sources] };
  return { ...r, sources: r.sources.length ? r.sources : [...PROSPECT_SOURCES] };
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

/** Owner/admin only: replace the workspace's Source list. Prospects keep their current source. */
export async function updateProspectSources(tenantId: string, actor: Actor, input: unknown): Promise<MutationResult> {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return { ok: false, error: 'no_permission', message: 'Only owners and admins can change this.' };
  }
  const parsed = prospectSourcesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check the sources and try again.' };
  const v = { prospectSources: parsed.data, updatedBy: actor.userId };
  await tenantTransaction((tx) =>
    tx
      .insert(organizationSettings)
      .values({ tenantId, ...v })
      .onConflictDoUpdate({ target: organizationSettings.tenantId, set: v }),
  );
  return { ok: true };
}
