import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for the Prospect Board (0079). Two throwaway tenants,
 * deleted at the end.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospects-db.ts
 */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, runWithTenantContext, tenantTransaction } = await import('../src/lib/db-context');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS A', ${`zz-pros-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS B', ${`zz-pros-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const user = `usr_prostest_${stamp}`;
  const inA = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
    runWithSystemContext(A, () => tenantTransaction(fn as never)) as Promise<T>;

  try {
    const p = await inA(async (tx) => {
      const [row] = await tx.insert(s.prospects).values({ tenantId: A, companyName: 'Acme Test', sourceTag: 'selftest' }).returning();
      return row!;
    });
    check('schema: prospect insert defaults', p.stage === 'dump' && Array.isArray(p.clusterTags) && p.clusterTags.length === 0, { stage: p.stage, tags: p.clusterTags });

    // Each failing insert runs in its own transaction (a failed statement aborts it).
    check('schema: size_band CHECK', await throws(() => inA((tx) => tx.insert(s.prospects).values({ tenantId: A, companyName: 'X', sourceTag: 't', sizeBand: '50-100' as never }))));
    check('schema: icp_score CHECK', await throws(() => inA((tx) => tx.insert(s.prospects).values({ tenantId: A, companyName: 'X', sourceTag: 't', icpScore: 101 }))));

    const seenByB = await runWithTenantContext({ tenantId: B, userId: user }, () =>
      tenantTransaction((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, p.id))),
    );
    check('schema: RLS isolation', seenByB.length === 0, seenByB.length);

    await inA((tx) => tx.insert(s.prospectVotes).values({ tenantId: A, prospectId: p.id, userId: user, kind: 'priority' }));
    check('schema: vote PK', await throws(() => inA((tx) => tx.insert(s.prospectVotes).values({ tenantId: A, prospectId: p.id, userId: user, kind: 'priority' }))));

    check('schema: ai_suggestions accepts prospect', !(await throws(() =>
      inA((tx) => tx.insert(s.aiSuggestions).values({
        tenantId: A, entityType: 'prospect' as never, entityId: p.id, field: 'icp_score' as never,
        suggestedValue: 80, evidenceQuote: 'reason', sourceType: 'enrichment' as never, sourceId: p.id, confidence: 0.5, model: 'm',
      })),
    )));

    check('schema: lead_sources accepts prospect_board', !(await throws(() =>
      inA((tx) => tx.insert(s.leadSources).values({ tenantId: A, name: 'Prospect Board', type: 'prospect_board' as never, secretToken: 'x'.repeat(64) })),
    )));

    const dealId = await inA(async (tx) => {
      const [d] = await tx.insert(s.deals).values({ tenantId: A, name: 'From prospect', sourceProspectId: p.id }).returning();
      return d!.id;
    });
    await inA((tx) => tx.delete(s.prospects).where(eq(s.prospects.id, p.id)));
    const [after] = await inA((tx) => tx.select({ sp: s.deals.sourceProspectId }).from(s.deals).where(eq(s.deals.id, dealId)));
    check('schema: deals.source_prospect_id set null on prospect hard delete', after?.sp === null, after);

    /* ---------------- queries + mutations (Task 3) ---------------- */
    const q = await import('../src/lib/prospects/queries');
    const m = await import('../src/lib/prospects/mutations');
    const memberU = `usr_member_${stamp}`;
    const otherU = `usr_other_${stamp}`;
    const mgrU = `usr_mgr_${stamp}`;
    const member = { userId: memberU, role: 'member' as const };
    const other = { userId: otherU, role: 'member' as const };
    const mgr = { userId: mgrU, role: 'manager' as const };
    const asA = <T,>(fn: () => Promise<T>) => runWithTenantContext({ tenantId: A, userId: memberU }, fn);
    const asB = <T,>(fn: () => Promise<T>) => runWithTenantContext({ tenantId: B, userId: 'usr_b' }, fn);
    const mk = async (name: string, extra: Record<string, unknown> = {}) => {
      const r = await asA(() => m.createProspect(A, member, { companyName: name, sourceTag: 'selftest', clusterTags: [] } as never));
      if (!r.ok) throw new Error(`create failed: ${r.error}`);
      if (Object.keys(extra).length) {
        await inA((tx) => tx.update(s.prospects).set(extra as never).where(eq(s.prospects.id, r.id)));
      }
      return r.id;
    };
    const hist = (id: string) =>
      inA((tx) =>
        tx.select().from(s.prospectStageHistory).where(eq(s.prospectStageHistory.prospectId, id)).orderBy(s.prospectStageHistory.changedAt),
      );
    const stageOf = async (id: string) => (await inA((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, id))))[0]!;

    const c1 = await mk('Create Co');
    const h1 = await hist(c1);
    check('create: history row', h1.length === 1 && h1[0]!.fromStage === null && h1[0]!.toStage === 'dump' && h1[0]!.changedBy === memberU, h1);
    check('create: created_by set', (await stageOf(c1)).createdBy === memberU);

    const c2 = await mk('Chain Co');
    await asA(() => m.moveProspectStage(A, member, c2, 'researching'));
    await asA(() => m.moveProspectStage(A, member, c2, 'qualified'));
    const h2 = await hist(c2);
    check('move: chains history', h2.length === 3 && h2[1]!.fromStage === h2[0]!.toStage && h2[2]!.fromStage === h2[1]!.toStage && h2[2]!.toStage === 'qualified', h2.map((h) => [h.fromStage, h.toStage]));

    const c3 = await mk('Concurrent Co');
    const [r1, r2] = await Promise.all([
      asA(() => m.moveProspectStage(A, member, c3, 'ready')),
      asA(() => m.moveProspectStage(A, member, c3, 'ready')),
    ]);
    const h3 = (await hist(c3)).filter((h) => h.toStage === 'ready');
    check('move: concurrent', r1.ok && r2.ok && (await stageOf(c3)).stage === 'ready' && h3.length === 1, { r1, r2, n: h3.length });

    const c4 = await mk('Park Co');
    await asA(() => m.moveProspectStage(A, member, c4, 'parked'));
    const parked = await stageOf(c4);
    await asA(() => m.moveProspectStage(A, member, c4, 'researching'));
    const unparked = await stageOf(c4);
    check('move: park sets reason', parked.parkedReason === 'manual' && unparked.parkedReason === null, [parked.parkedReason, unparked.parkedReason]);

    const c5 = await mk('Tenant Co');
    const xr = await asB(() => m.moveProspectStage(B, { userId: 'usr_b', role: 'member' }, c5, 'ready'));
    check('move: cross-tenant id', !xr.ok && xr.error === 'not_found' && (await stageOf(c5)).stage === 'dump', xr);

    const c6 = await mk('Promoted Co', { promotedDealId: dealId });
    const mp = await asA(() => m.moveProspectStage(A, member, c6, 'ready'));
    const ep = await asA(() => m.updateProspect(A, member, c6, { notes: 'x' }));
    check('move/edit: promoted read-only', !mp.ok && mp.error === 'promoted' && !ep.ok && ep.error === 'promoted', { mp, ep });

    const c7 = await mk('Claimed Co', { claimedBy: otherU });
    const c8 = await mk('Deleted Co', { deletedAt: new Date() });
    const c9 = await mk('Fine Co');
    const bm = await asA(() => m.bulkMoveStage(A, member, [c9, c7, c8], 'researching'));
    check('bulk: mixed', bm.moved.length === 1 && bm.moved[0] === c9 && JSON.stringify(bm.skipped.map((x) => x.reason)) === JSON.stringify(['claimed_by_other', 'deleted']), bm);

    const c10 = await mk('Bulk Park 1');
    const c11 = await mk('Bulk Park 2');
    const bp = await asA(() => m.bulkMoveStage(A, member, [c10, c11], 'parked'));
    check('bulk: park needs manager', bp.moved.length === 0 && bp.skipped.length === 2 && bp.skipped.every((x) => x.reason === 'no_permission') && (await stageOf(c10)).stage === 'dump', bp);
    const bpm = await asA(() => m.bulkMoveStage(A, mgr, [c10, c11], 'parked'));
    check('bulk: manager can park', bpm.moved.length === 2, bpm);

    let badMove: Awaited<ReturnType<typeof m.moveProspectStage>> | null = null;
    let badThrew = false;
    try { badMove = await asA(() => m.moveProspectStage(A, member, 'abc', 'ready')); } catch { badThrew = true; }
    check('move: malformed id', !badThrew && badMove !== null && !badMove.ok && badMove.error === 'not_found', badMove);
    const c12 = await mk('Bulk Bad 1');
    const c13 = await mk('Bulk Bad 2');
    const bb = await asA(() => m.bulkMoveStage(A, member, [c12, 'abc', c13], 'researching'));
    check('bulk: malformed id among valid', bb.moved.length === 2 && bb.skipped.length === 1 && bb.skipped[0]!.id === 'abc' && bb.skipped[0]!.reason === 'not_found', bb);
    check('get: malformed id is null', (await asA(() => q.getProspect(A, 'abc'))) === null);

    const upd = await asA(() => m.updateProspect(A, member, c1, { industry: 'Steel' }));
    check('update: ok and merges', upd.ok && (await stageOf(c1)).industry === 'Steel' && (await stageOf(c1)).companyName === 'Create Co');
    const gone = await asA(() => q.getProspect(A, c8));
    check('get: deleted is null', gone === null);

    // list filters
    const lf = await mk('Filter Mine', { sourceTag: 'src-x', claimedBy: memberU });
    const lu = await mk('Filter Unclaimed', { sourceTag: 'src-x' });
    const lo = await mk('Filter Other', { sourceTag: 'src-y', claimedBy: otherU, createdBy: otherU, stage: 'qualified' });
    const deal2 = await inA(async (tx) => (await tx.insert(s.deals).values({ tenantId: A, name: 'Second' }).returning())[0]!.id);
    const lp = await mk('Filter Promoted', { sourceTag: 'src-x', promotedDealId: deal2 });
    const ids = async (f: Record<string, unknown>) => (await asA(() => q.listProspectsForBoard(A, memberU, f as never))).cards.map((c) => c.id);
    const mine = await ids({ mine: true });
    check('list: mine', mine.includes(lf) && mine.includes(lu) && !mine.includes(lo), mine.length);
    const uncl = await ids({ unclaimed: true });
    check('list: unclaimed', uncl.includes(lu) && !uncl.includes(lf) && !uncl.includes(lo));
    const src = await ids({ source: 'src-y' });
    check('list: source', src.length === 1 && src[0] === lo, src);
    const stg = await ids({ stage: 'qualified' });
    check('list: stage', stg.includes(lo) && !stg.includes(lu));
    const all = await ids({});
    check('list: hides promoted and deleted by default', !all.includes(lp) && !all.includes(c6) && !all.includes(c8));
    check('list: showPromoted', (await ids({ showPromoted: true })).includes(lp));
    check('list: q', (await ids({ q: 'filter unclaim' })).join() === lu);
    check('list: source tags', (await asA(() => q.listSourceTags(A))).includes('src-y'));

    const vp = await mk('Voted Co');
    await inA((tx) =>
      tx.insert(s.prospectVotes).values([
        { tenantId: A, prospectId: vp, userId: 'v1', kind: 'priority' },
        { tenantId: A, prospectId: vp, userId: 'v2', kind: 'priority' },
        { tenantId: A, prospectId: vp, userId: 'v1', kind: 'know_someone' },
      ]),
    );
    const card = (await asA(() => q.listProspectsForBoard(A, memberU, {}))).cards.find((c) => c.id === vp);
    check('list: vote counts', card?.votesPriority === 2 && card?.votesKnowSomeone === 1, card);

    for (const n of ['Trunc 1', 'Trunc 2', 'Trunc 3', 'Trunc 4']) await mk(n, { sourceTag: 'src-trunc' });
    const tr = await asA(() => q.listProspectsForBoard(A, memberU, { source: 'src-trunc' } as never, 3));
    check('list: truncated flag', tr.truncated === true && tr.cards.length === 3, { truncated: tr.truncated, n: tr.cards.length });
    const tr2 = await asA(() => q.listProspectsForBoard(A, memberU, { source: 'src-trunc' } as never, 4));
    check('list: not truncated at exact limit', tr2.truncated === false && tr2.cards.length === 4, { truncated: tr2.truncated, n: tr2.cards.length });

    /* ---------------- claims (Stage 2 Task 2) ---------------- */
    const cl = await import('../src/lib/prospects/claims');
    const ownerU = `usr_owner_${stamp}`;
    const ghostU = `usr_ghost_${stamp}`; // inactive member of A
    const bOnlyU = `usr_bonly_${stamp}`; // member of B only
    const owner = { userId: ownerU, role: 'owner' as const };
    await inA((tx) =>
      tx.insert(s.memberships).values([
        { tenantId: A, userId: memberU, role: 'member' },
        { tenantId: A, userId: otherU, role: 'member' },
        { tenantId: A, userId: mgrU, role: 'manager' },
        { tenantId: A, userId: ownerU, role: 'owner' },
        { tenantId: A, userId: ghostU, role: 'member', status: 'suspended' as never },
      ] as never),
    );
    await runWithSystemContext(B, () =>
      tenantTransaction((tx) => tx.insert(s.memberships).values({ tenantId: B, userId: bOnlyU, role: 'member' }) as never),
    );
    await db.execute(sql`INSERT INTO users (id, email, first_name, last_name) VALUES (${ownerU}, ${`${ownerU}@example.test`}, 'Olive', 'Owner') ON CONFLICT DO NOTHING`);
    const asU = <T,>(uid: string, fn: () => Promise<T>) => runWithTenantContext({ tenantId: A, userId: uid }, fn);
    const row = async (id: string) => (await inA((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, id))))[0]!;
    const DAY = 86_400_000;

    const k1 = await mk('Claim Co');
    const before = (await row(k1)).lastActivityAt;
    await new Promise((r) => setTimeout(r, 15));
    const t0 = new Date();
    const k1r = await asU(memberU, () => cl.claimProspect(A, member, k1, t0));
    const k1row = await row(k1);
    check('claim: sets 14-day expiry', k1r.ok && k1row.claimedBy === memberU && Math.abs(k1row.claimExpiresAt!.getTime() - (t0.getTime() + 14 * DAY)) < 60_000, { k1r, exp: k1row.claimExpiresAt });
    check('claim bumps last_activity_at', k1row.lastActivityAt.getTime() > before.getTime(), [before, k1row.lastActivityAt]);

    await inA((tx) => tx.insert(s.organizationSettings).values({ tenantId: A, prospectClaimDays: 7 } as never));
    const k2 = await mk('Claim Seven');
    const k2r = await asU(memberU, () => cl.claimProspect(A, member, k2, t0));
    const k2row = await row(k2);
    check('claim: honours prospect_claim_days=7', k2r.ok && Math.abs(k2row.claimExpiresAt!.getTime() - (t0.getTime() + 7 * DAY)) < 60_000, k2row.claimExpiresAt);

    const k3 = await mk('Claim Race');
    const [ra, rb] = await Promise.all([
      asU(memberU, () => cl.claimProspect(A, member, k3)),
      asU(otherU, () => cl.claimProspect(A, other, k3)),
    ]);
    const k3row = await row(k3);
    const winners = [ra, rb].filter((r) => r.ok).length;
    const losers = [ra, rb].filter((r) => !r.ok && r.error === 'claimed_by_other').length;
    const winnerU = ra.ok ? memberU : otherU;
    check('claim: concurrent', winners === 1 && losers === 1 && k3row.claimedBy === winnerU, { ra, rb, by: k3row.claimedBy });

    const deal3 = await inA(async (tx) => (await tx.insert(s.deals).values({ tenantId: A, name: 'Third' }).returning())[0]!.id);
    const kp = await mk('Claim Promoted', { promotedDealId: deal3 });
    const kd = await mk('Claim Deleted', { deletedAt: new Date() });
    const rp = await asU(memberU, () => cl.claimProspect(A, member, kp));
    const rd = await asU(memberU, () => cl.claimProspect(A, member, kd));
    check('claim: promoted/deleted blocked', !rp.ok && rp.error === 'promoted' && !rd.ok && rd.error === 'deleted', { rp, rd });

    const kx = await mk('Claim Tenant');
    const rx = await runWithTenantContext({ tenantId: B, userId: bOnlyU }, () => cl.claimProspect(B, { userId: bOnlyU, role: 'member' }, kx));
    check('claim: cross-tenant id -> not_found', !rx.ok && rx.error === 'not_found' && (await row(kx)).claimedBy === null, rx);

    const rel = await asU(memberU, () => cl.releaseProspect(A, member, k1));
    const relRow = await row(k1);
    check('release: clears columns', rel.ok && relRow.claimedBy === null && relRow.claimedAt === null && relRow.claimExpiresAt === null, { rel, relRow });
    const rel2 = await asU(memberU, () => cl.releaseProspect(A, member, k1));
    check('release: unclaimed -> not_claimed', !rel2.ok && rel2.error === 'not_claimed', rel2);

    const k4 = await mk('Reassign Co', { claimedBy: memberU, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
    const rd1 = await asU(memberU, () => cl.reassignClaim(A, member, k4, otherU));
    check('reassign: member denied', !rd1.ok && rd1.error === 'no_permission' && (await row(k4)).claimedBy === memberU, rd1);
    const rn1 = await asU(ownerU, () => cl.reassignClaim(A, owner, k4, bOnlyU));
    const rn2 = await asU(ownerU, () => cl.reassignClaim(A, owner, k4, ghostU));
    check('reassign: to non-member/other-tenant user -> not_found', !rn1.ok && rn1.error === 'not_found' && !rn2.ok && rn2.error === 'not_found', { rn1, rn2 });
    const ro = await asU(ownerU, () => cl.reassignClaim(A, owner, k4, otherU));
    const k4row = await row(k4);
    const notes = await asU(otherU, () =>
      tenantTransaction((tx) =>
        tx.select().from(s.notifications).where(eq(s.notifications.recipientUserId, otherU)),
      ),
    );
    const nrow = notes.filter((n) => n.type === 'prospect_claim_assigned');
    check('reassign: owner to member', ro.ok && k4row.claimedBy === otherU && nrow.length === 1 && nrow[0]!.entityId === k4 && nrow[0]!.title === 'Olive Owner assigned you Reassign Co', { ro, by: k4row.claimedBy, nrow });

    // Manager scope: other reports to mgr, so member is outside the manager's team.
    await inA((tx) => tx.update(s.memberships).set({ reportsToUserId: mgrU } as never).where(eq(s.memberships.userId, otherU)));
    const ros = await asU(mgrU, () => cl.reassignClaim(A, mgr, k4, memberU));
    const rin = await asU(mgrU, () => cl.reassignClaim(A, mgr, k4, otherU));
    check('reassign: manager out of scope', !ros.ok && ros.error === 'out_of_scope' && rin.ok, { ros, rin });

    // Team scope over the CURRENT holder: mgr's team is {mgr, other}; member is outside it.
    const viewerU = `usr_viewer_${stamp}`;
    await inA((tx) => tx.insert(s.memberships).values({ tenantId: A, userId: viewerU, role: 'viewer' } as never));
    const held = (by: string) => ({ claimedBy: by, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
    const o1 = await mk('Scope Out Release', held(memberU));
    const ro1 = await asU(mgrU, () => cl.releaseProspect(A, mgr, o1));
    check("release: manager on out-of-team rep's claim -> out_of_scope", !ro1.ok && ro1.error === 'out_of_scope' && (await row(o1)).claimedBy === memberU, ro1);
    const o1b = await asU(ownerU, () => cl.releaseProspect(A, owner, o1));
    check("release: owner on any claim", o1b.ok, o1b);
    const o2 = await mk('Scope Out Reassign', held(memberU));
    const ro2 = await asU(mgrU, () => cl.reassignClaim(A, mgr, o2, otherU));
    check('reassign: holder out of team -> out_of_scope', !ro2.ok && ro2.error === 'out_of_scope' && (await row(o2)).claimedBy === memberU, ro2);
    const o3 = await mk('Scope In Bulk', held(otherU));
    const o4 = await mk('Scope Out Bulk', held(memberU));
    const bo = await asU(mgrU, () => cl.bulkReleaseClaims(A, mgr, [o3, o4]));
    check('bulk release: manager mixes in-team and out-of-team', bo.released.length === 1 && bo.released[0] === o3 && bo.skipped.length === 1 && bo.skipped[0]!.id === o4 && bo.skipped[0]!.reason === 'out_of_scope', bo);
    const o5 = await mk('Viewer Target');
    const rv = await asU(ownerU, () => cl.reassignClaim(A, owner, o5, viewerU));
    check('reassign: viewer target -> no_permission', !rv.ok && rv.error === 'no_permission' && rv.message === "That person can't claim prospects." && (await row(o5)).claimedBy === null, rv);

    const b1 = await mk('Bulk Rel Own', { claimedBy: memberU, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
    const b2 = await mk('Bulk Rel Other', { claimedBy: otherU, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
    const br = await asU(memberU, () => cl.bulkReleaseClaims(A, member, [b1, b2, 'abc']));
    check('bulk release: mixed', br.released.length === 1 && br.released[0] === b1 && JSON.stringify(br.skipped.map((x) => [x.id, x.reason])) === JSON.stringify([[b2, 'claimed_by_other'], ['abc', 'not_found']]) && (await row(b2)).claimedBy === otherU, br);

    /* ---------------- votes + activity touch (Stage 2 Task 3) ---------------- */
    const vt = await import('../src/lib/prospects/votes');
    const act = await import('../src/lib/prospects/activity');
    const viewer = { userId: viewerU, role: 'viewer' as const };
    const v1 = await mk('Vote Co');
    const va = await asU(memberU, () => vt.toggleVote(A, member, v1, 'priority'));
    const vb = await asU(memberU, () => vt.toggleVote(A, member, v1, 'priority'));
    check('vote: toggle on/off', va.ok && va.voted && va.priority === 1 && vb.ok && !vb.voted && vb.priority === 0, { va, vb });
    await asU(memberU, () => vt.toggleVote(A, member, v1, 'priority'));
    const vc = await asU(memberU, () => vt.toggleVote(A, member, v1, 'know_someone'));
    const vd = await asU(otherU, () => vt.toggleVote(A, other, v1, 'priority'));
    check('vote: two kinds independent', vc.ok && vc.voted && vc.knowSomeone === 1 && vc.priority === 1 && vd.ok && vd.priority === 2 && vd.knowSomeone === 1, { vc, vd });
    const vDeal = await inA(async (tx) => (await tx.insert(s.deals).values({ tenantId: A, name: 'Vote deal' }).returning())[0]!.id);
    const vpro = await mk('Vote Promoted', { promotedDealId: vDeal });
    const vpr = await asU(memberU, () => vt.toggleVote(A, member, vpro, 'priority'));
    check('vote: promoted blocked', !vpr.ok && vpr.error === 'promoted', vpr);
    const vv = await asU(viewerU, () => vt.toggleVote(A, viewer, v1, 'priority'));
    check('vote: viewer denied', !vv.ok && vv.error === 'no_permission', vv);
    const vx = await asB(() => vt.toggleVote(B, { userId: 'usr_b', role: 'member' }, v1, 'priority'));
    check('vote: cross-tenant -> not_found', !vx.ok && vx.error === 'not_found', vx);
    const tp = await inA((tx) => act.touchProspectActivity(tx, A, vpro));
    const tdId = await mk('Touch Deleted', { deletedAt: new Date() });
    const td = await inA((tx) => act.touchProspectActivity(tx, A, tdId));
    const tn = await inA((tx) => act.touchProspectActivity(tx, A, '00000000-0000-0000-0000-000000000000'));
    check('touch: read_only for promoted/deleted, not_found for missing', tp === 'read_only' && td === 'read_only' && tn === 'not_found', { tp, td, tn });
    const tv = await mk('Touch Co', { lastActivityAt: new Date(Date.now() - 10 * DAY) });
    const lastBefore = (await row(tv)).lastActivityAt!.getTime();
    const trr = await inA((tx) => act.touchProspectActivity(tx, A, tv));
    check('touch: bumps last_activity_at', trr === 'ok' && (await row(tv)).lastActivityAt!.getTime() > lastBefore + DAY, trr);
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nprospects db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
