import 'server-only';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { notes, type Note } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';

export type NoteEntityType = 'deal' | 'company' | 'contact';

/**
 * Notes for a given entity, newest first. Capped at a sane limit so a
 * long-lived account doesn't load thousands of rows on a detail page;
 * the cap is far above any realistic usage and the index covers the
 * query.
 */
export async function listNotesForEntity(
  tenantId: string,
  entityType: NoteEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<Note[]> {
  const limit = options.limit ?? 100;
  return await timeQuery('notes.forEntity', async () =>
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.tenantId, tenantId),
            eq(notes.entityType, entityType),
            eq(notes.entityId, entityId),
            isNull(notes.deletedAt),
          ),
        )
        .orderBy(desc(notes.createdAt))
        .limit(limit),
    ),
  );
}
