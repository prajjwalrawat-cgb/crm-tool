'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { withTenantSession } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import {
  deleteConnection,
  updateExclusions,
} from '@/lib/email/gmail/connections';

export type EmailSyncResult = { ok: true } | { ok: false; message: string };

/**
 * Disconnect the current user's Gmail: deletes the connection row (and its
 * encrypted refresh token) immediately, stopping all further sync. Already-
 * captured activities remain — they're CRM records now.
 */
export async function disconnectGmailAction(): Promise<EmailSyncResult> {
  return withTenantSession(async ({ tenant, userId }) => {
    await runWithTenantContext({ tenantId: tenant.id, userId }, async () => {
      await deleteConnection(tenant.id, userId);
    });
    revalidatePath('/dashboard/settings/email-sync');
    return { ok: true };
  });
}

const exclusionsSchema = z.object({
  domains: z.array(z.string().min(1).max(255)).max(100),
  addresses: z.array(z.string().min(1).max(320)).max(200),
});

/** Update the per-user never-sync lists (domains + addresses). */
export async function updateExclusionsAction(input: {
  domains: string[];
  addresses: string[];
}): Promise<EmailSyncResult> {
  const parsed = exclusionsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid exclusion list.' };

  return withTenantSession(async ({ tenant, userId }) => {
    const domains = parsed.data.domains
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const addresses = parsed.data.addresses
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    await runWithTenantContext({ tenantId: tenant.id, userId }, async () => {
      await updateExclusions(tenant.id, userId, {
        excludedDomains: domains,
        excludedAddresses: addresses,
      });
    });
    revalidatePath('/dashboard/settings/email-sync');
    return { ok: true };
  });
}
