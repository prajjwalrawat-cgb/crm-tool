'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { withTenantSession } from '@/lib/auth-guard';
import { setMute } from '@/lib/reports/manager/digest';

/** Mute / unmute a report digest for the signed-in user. */
export async function setDigestMuteAction(digest: 'daily' | 'weekly' | 'all', muted: boolean): Promise<{ ok: boolean }> {
  if (!z.enum(['daily', 'weekly', 'all']).safeParse(digest).success) return { ok: false };
  return await withTenantSession(async ({ tenant, userId }) => {
    await setMute(tenant.id, userId, digest, muted);
    revalidatePath('/dashboard/settings/digests');
    return { ok: true };
  });
}
