import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { leadSources } from '@/db/schema';
import type { DbExecutor } from '@/lib/db-context';
import { generateSourceSecret } from '@/lib/lead-capture/signature';

/**
 * The tenant's Prospect Board lead source, created on first use (mirrors
 * `ensureCsvImportSource`). An admin-created `prospect_board` source is
 * reused: the oldest active one wins. Runs in the caller's transaction; a
 * per-tenant advisory lock stops two first promotes creating two sources.
 */
export async function ensureProspectBoardSource(tx: DbExecutor, tenantId: string, createdBy: string): Promise<string> {
  const oldest = async () => {
    const [row] = await tx
      .select({ id: leadSources.id })
      .from(leadSources)
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.type, 'prospect_board'), eq(leadSources.isActive, true)))
      .orderBy(asc(leadSources.createdAt), asc(leadSources.id))
      .limit(1);
    return row?.id ?? null;
  };
  const found = await oldest();
  if (found) return found;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prospect_board_source:${tenantId}`}))`);
  const again = await oldest();
  if (again) return again;
  const [row] = await tx
    .insert(leadSources)
    .values({ tenantId, name: 'Prospect Board', type: 'prospect_board', secretToken: generateSourceSecret(), createdBy })
    .returning({ id: leadSources.id });
  return row!.id;
}
