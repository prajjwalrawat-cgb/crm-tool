import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { emailMessages, type EmailMessage } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';

export type EmailEntityType = 'deal' | 'company' | 'contact';

/**
 * Emails attached to one entity, newest first. Used by the unified
 * entity timeline. Capped to a sensible per-page limit; tenants
 * with very chatty entities can paginate later.
 */
export async function listEmailsForEntity(
  tenantId: string,
  entityType: EmailEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<EmailMessage[]> {
  const limit = options.limit ?? 100;
  return await timeQuery('email.forEntity', async () =>
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.entityType, entityType),
            eq(emailMessages.entityId, entityId),
          ),
        )
        .orderBy(desc(emailMessages.createdAt))
        .limit(limit),
    ),
  );
}
