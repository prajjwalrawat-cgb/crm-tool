import 'server-only';

import { and, eq } from 'drizzle-orm';

import { prospects, prospectVotes } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { touchProspectActivity } from './activity';
import { fail, MESSAGES, UUID_RE, type MutationResult } from './mutations';
import { editBlock, type Actor } from './rules';

export type VoteKind = 'know_someone' | 'priority';

export type VoteResult =
  | { ok: true; voted: boolean; knowSomeone: number; priority: number }
  | Extract<MutationResult, { ok: false }>;

/** Toggle the actor's vote of one kind; the prospect row is locked so promote/delete races serialize. */
export async function toggleVote(
  tenantId: string,
  actor: Actor,
  id: string,
  kind: VoteKind,
): Promise<VoteResult> {
  if (kind !== 'know_someone' && kind !== 'priority') return { ok: false, error: 'invalid', message: MESSAGES.no_permission };
  if (!UUID_RE.test(id)) return fail('not_found') as Extract<MutationResult, { ok: false }>;
  return tenantTransaction(async (tx): Promise<VoteResult> => {
    const [cur] = await tx
      .select({ promotedDealId: prospects.promotedDealId, deletedAt: prospects.deletedAt })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return fail('not_found') as Extract<MutationResult, { ok: false }>;
    const block = editBlock(cur, actor);
    if (block) return fail(block) as Extract<MutationResult, { ok: false }>;

    const mine = and(
      eq(prospectVotes.tenantId, tenantId),
      eq(prospectVotes.prospectId, id),
      eq(prospectVotes.userId, actor.userId),
      eq(prospectVotes.kind, kind),
    );
    const [had] = await tx.select({ k: prospectVotes.kind }).from(prospectVotes).where(mine).limit(1);
    if (had) await tx.delete(prospectVotes).where(mine);
    else await tx.insert(prospectVotes).values({ tenantId, prospectId: id, userId: actor.userId, kind });
    await touchProspectActivity(tx, tenantId, id);

    const all = await tx
      .select({ kind: prospectVotes.kind })
      .from(prospectVotes)
      .where(and(eq(prospectVotes.tenantId, tenantId), eq(prospectVotes.prospectId, id)));
    return {
      ok: true,
      voted: !had,
      knowSomeone: all.filter((v) => v.kind === 'know_someone').length,
      priority: all.filter((v) => v.kind === 'priority').length,
    };
  });
}
