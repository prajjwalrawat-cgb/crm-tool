import 'server-only';

import { eq } from 'drizzle-orm';

import {
  workspaceSettings,
  type WorkspaceFeatureFlag,
  type WorkspaceSettings,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Read the Phase-2 feature-flag row for a tenant. Mirrors `getOrgSettings`:
 * a single indexed PK SELECT, lazily UPSERTing an all-OFF row on first miss
 * (the seed script flips CGB's flags ON; every other tenant starts dark).
 *
 * Frozen so callers can't mutate it — the write path is `setWorkspaceFlagsRow`.
 */
export async function getWorkspaceSettings(
  tenantId: string,
): Promise<WorkspaceSettings> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId))
      .limit(1),
  );
  if (rows[0]) return Object.freeze({ ...rows[0] });

  const [inserted] = await tenantTransaction((tx) =>
    tx
      .insert(workspaceSettings)
      .values({ tenantId })
      .onConflictDoNothing({ target: workspaceSettings.tenantId })
      .returning(),
  );
  if (inserted) return Object.freeze({ ...inserted });

  const after = await tenantTransaction((tx) =>
    tx
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId))
      .limit(1),
  );
  if (!after[0]) {
    throw new Error('workspace_settings seeding failed (RLS?)');
  }
  return Object.freeze({ ...after[0] });
}

/**
 * Convenience: is a single Phase-2 module enabled for this tenant? Every
 * module gate ("is STAGE_GATES_ENABLED on?") funnels through here so the
 * flag semantics live in one place.
 */
export async function isFeatureEnabled(
  tenantId: string,
  flag: WorkspaceFeatureFlag,
): Promise<boolean> {
  const settings = await getWorkspaceSettings(tenantId);
  return settings[flag] === true;
}

/**
 * Update one or more feature flags for a tenant. Only the provided keys are
 * written. Returns the fresh row. Caller is responsible for authorization
 * (admin-only) — this is the raw write path.
 */
export async function setWorkspaceFlags(
  tenantId: string,
  patch: Partial<Record<WorkspaceFeatureFlag, boolean>>,
): Promise<WorkspaceSettings> {
  // Ensure a row exists first (lazy upsert), then patch.
  await getWorkspaceSettings(tenantId);
  const [updated] = await tenantTransaction((tx) =>
    tx
      .update(workspaceSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaceSettings.tenantId, tenantId))
      .returning(),
  );
  if (!updated) throw new Error('workspace_settings update failed');
  return Object.freeze({ ...updated });
}
