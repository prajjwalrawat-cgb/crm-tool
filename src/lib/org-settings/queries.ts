import 'server-only';

import { eq } from 'drizzle-orm';

import {
  organizationSettings,
  type OrganizationSettings,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Read the organization settings row for a tenant. The migration
 * already seeded a row for every existing tenant, so the lookup is
 * a single indexed PK SELECT. We still upsert on miss as a defense
 * against a tenant being created without the seeding path firing.
 *
 * The result is frozen so consumers can't accidentally mutate it
 * — the canonical write path is the per-section action.
 */
export async function getOrgSettings(
  tenantId: string,
): Promise<OrganizationSettings> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.tenantId, tenantId))
      .limit(1),
  );
  if (rows[0]) return Object.freeze({ ...rows[0] });

  // Lazy seed. Use ON CONFLICT in case a concurrent request just
  // inserted the row.
  const [inserted] = await tenantTransaction(async (tx) =>
    tx
      .insert(organizationSettings)
      .values({ tenantId })
      .onConflictDoNothing({ target: organizationSettings.tenantId })
      .returning(),
  );
  if (inserted) return Object.freeze({ ...inserted });

  // Conflict happened — re-read.
  const after = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.tenantId, tenantId))
      .limit(1),
  );
  if (!after[0]) {
    throw new Error('organization_settings seeding failed (RLS?)');
  }
  return Object.freeze({ ...after[0] });
}
