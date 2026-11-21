import 'server-only';

import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';

import {
  offerings,
  prospects,
  prospectStageHistory,
  prospectVotes,
  type Prospect,
  type ProspectStage,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { ProspectCard, ProspectFilters } from './rules';

const BOARD_LIMIT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Board cards for a tenant. Callers run inside runWithTenantContext. */
export async function listProspectsForBoard(
  tenantId: string,
  viewerId: string,
  f: ProspectFilters,
): Promise<ProspectCard[]> {
  return tenantTransaction(async (tx) => {
    const votes = tx
      .select({
        prospectId: prospectVotes.prospectId,
        know: sql<number>`count(*) FILTER (WHERE ${prospectVotes.kind} = 'know_someone')::int`.as('know'),
        prio: sql<number>`count(*) FILTER (WHERE ${prospectVotes.kind} = 'priority')::int`.as('prio'),
      })
      .from(prospectVotes)
      .where(eq(prospectVotes.tenantId, tenantId))
      .groupBy(prospectVotes.prospectId)
      .as('v');

    const conds: (SQL | undefined)[] = [eq(prospects.tenantId, tenantId), isNull(prospects.deletedAt)];
    if (f.mine) conds.push(or(eq(prospects.claimedBy, viewerId), eq(prospects.createdBy, viewerId)));
    if (f.unclaimed) conds.push(isNull(prospects.claimedBy));
    if (f.source) conds.push(eq(prospects.sourceTag, f.source));
    if (f.stage) conds.push(eq(prospects.stage, f.stage));
    if (!f.showPromoted) conds.push(isNull(prospects.promotedDealId));
    if (f.q) {
      const pat = `%${escapeLike(f.q)}%`;
      conds.push(or(ilike(prospects.companyName, pat), ilike(prospects.contactName, pat)));
    }

    const rows = await tx
      .select({
        id: prospects.id,
        companyName: prospects.companyName,
        contactName: prospects.contactName,
        contactEmail: prospects.contactEmail,
        sourceTag: prospects.sourceTag,
        clusterTags: prospects.clusterTags,
        industry: prospects.industry,
        city: prospects.city,
        state: prospects.state,
        sizeBand: prospects.sizeBand,
        productFitOfferingId: prospects.productFitOfferingId,
        productFitName: offerings.name,
        icpScore: prospects.icpScore,
        stage: prospects.stage,
        claimedBy: prospects.claimedBy,
        claimExpiresAt: prospects.claimExpiresAt,
        know: votes.know,
        prio: votes.prio,
        promotedDealId: prospects.promotedDealId,
        lastActivityAt: prospects.lastActivityAt,
      })
      .from(prospects)
      .leftJoin(offerings, eq(offerings.id, prospects.productFitOfferingId))
      .leftJoin(votes, eq(votes.prospectId, prospects.id))
      .where(and(...conds))
      .orderBy(desc(prospects.lastActivityAt))
      .limit(BOARD_LIMIT);

    return rows.map(({ know, prio, ...r }) => ({
      ...r,
      productFitName: r.productFitName ?? null,
      votesKnowSomeone: know ?? 0,
      votesPriority: prio ?? 0,
    }));
  });
}

export async function getProspect(tenantId: string, id: string): Promise<Prospect | null> {
  if (!UUID_RE.test(id)) return null;
  return tenantTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id), isNull(prospects.deletedAt)))
      .limit(1);
    return row ?? null;
  });
}

export async function listSourceTags(tenantId: string): Promise<string[]> {
  return tenantTransaction(async (tx) => {
    const rows = await tx
      .selectDistinct({ sourceTag: prospects.sourceTag })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), isNull(prospects.deletedAt)))
      .orderBy(prospects.sourceTag);
    return rows.map((r) => r.sourceTag);
  });
}

export async function listProspectStageHistory(
  tenantId: string,
  prospectId: string,
): Promise<{ fromStage: ProspectStage | null; toStage: ProspectStage; changedBy: string; changedAt: Date }[]> {
  if (!UUID_RE.test(prospectId)) return [];
  return tenantTransaction(async (tx) =>
    tx
      .select({
        fromStage: prospectStageHistory.fromStage,
        toStage: prospectStageHistory.toStage,
        changedBy: prospectStageHistory.changedBy,
        changedAt: prospectStageHistory.changedAt,
      })
      .from(prospectStageHistory)
      .where(and(eq(prospectStageHistory.tenantId, tenantId), eq(prospectStageHistory.prospectId, prospectId)))
      .orderBy(asc(prospectStageHistory.changedAt)),
  );
}
