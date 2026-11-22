import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold a real key: no test path here may reach Claude (in-process enrichment via the local dispatcher).
process.env.ANTHROPIC_API_KEY = '';

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
  const [tc] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS C', ${`zz-pros-c-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const C = tc!.id; // clean tenant for promote tests
  const [td] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS D', ${`zz-pros-d-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const D = td!.id; // clean tenant for maintenance tests
  const [te] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ PROS E', ${`zz-pros-e-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const E = te!.id; // clean tenant for enrichment tests
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
    // Product fit must be one of the tenant's own offerings.
    const cat = s.offeringCategory.enumValues[0];
    const [offA] = await inA((tx) => tx.insert(s.offerings).values({ tenantId: A, name: 'Own Product', category: cat }).returning());
    const [offB] = await runWithSystemContext(B, () =>
      tenantTransaction((tx) => tx.insert(s.offerings).values({ tenantId: B, name: 'Other Tenant Product', category: cat }).returning()),
    );
    const cOwn = await asA(() => m.createProspect(A, member, { companyName: 'Own Fit Co', sourceTag: 'selftest', clusterTags: [], productFitOfferingId: offA!.id } as never));
    const cFor = await asA(() => m.createProspect(A, member, { companyName: 'Foreign Fit Co', sourceTag: 'selftest', clusterTags: [], productFitOfferingId: offB!.id } as never));
    const forCount = (await inA((tx) => tx.select().from(s.prospects).where(eq(s.prospects.companyName, 'Foreign Fit Co')))).length;
    check('offering: create accepts own, rejects other tenant\'s', cOwn.ok && !cFor.ok && cFor.error === 'Unknown product.' && forCount === 0, { cOwn, cFor, forCount });
    const uFor = await asA(() => m.updateProspect(A, member, c1, { productFitOfferingId: offB!.id }));
    const uOwn = await asA(() => m.updateProspect(A, member, c1, { productFitOfferingId: offA!.id }));
    check('offering: update rejects other tenant\'s, accepts own', !uFor.ok && uFor.error === 'invalid' && uFor.message === 'Unknown product.' && uOwn.ok && (await stageOf(c1)).productFitOfferingId === offA!.id, { uFor, uOwn });
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
    // An expired claim is no claim: "unclaimed" includes it, and "mine" no longer does through it.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 86_400_000);
    const lxOther = await mk('Filter Expired Other', { sourceTag: 'src-x', claimedBy: otherU, claimExpiresAt: past, createdBy: otherU });
    const lxMine = await mk('Filter Expired Mine', { sourceTag: 'src-x', claimedBy: memberU, claimExpiresAt: past, createdBy: otherU });
    const lvMine = await mk('Filter Live Mine', { sourceTag: 'src-x', claimedBy: memberU, claimExpiresAt: future, createdBy: otherU });
    const lvOther = await mk('Filter Live Other', { sourceTag: 'src-x', claimedBy: otherU, claimExpiresAt: future, createdBy: otherU });
    const uncl2 = await ids({ unclaimed: true });
    const mine2 = await ids({ mine: true });
    check('list: unclaimed includes expired claims', uncl2.includes(lxOther) && uncl2.includes(lxMine) && !uncl2.includes(lvMine) && !uncl2.includes(lvOther), { uncl2 });
    check('list: mine = live claim or created by me', mine2.includes(lvMine) && !mine2.includes(lxMine) && !mine2.includes(lxOther) && !mine2.includes(lvOther) && mine2.includes(lf), { mine2 });
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

    /* ---------------- settings + claim-expiry flag (Stage 3 Task 4) ---------------- */
    const ps = await import('../src/lib/prospects/settings');
    const rules = await import('../src/lib/prospects/rules');
    const defs = await runWithTenantContext({ tenantId: B, userId: 'usr_b' }, () => ps.getProspectSettings(B));
    check('settings: defaults with no row', JSON.stringify(defs) === JSON.stringify({ claimDays: 14, claimExpiryEnabled: true, autoParkDays: 45, autoParkEnabled: true, enrichmentEnabled: false, aiSuggestionsEnabled: false }), defs);

    const full = { claimDays: 30, claimExpiryEnabled: true, autoParkDays: 60, autoParkEnabled: false, enrichmentEnabled: true };
    const setUpd = await asU(ownerU, () => ps.updateProspectSettings(A, owner, full));
    const back = await asU(ownerU, () => ps.getProspectSettings(A));
    check('settings: update + read back', setUpd.ok && back.claimDays === 30 && back.autoParkDays === 60 && back.autoParkEnabled === false && back.enrichmentEnabled === true && back.claimExpiryEnabled === true, { setUpd, back });
    const upB = await runWithTenantContext({ tenantId: B, userId: 'usr_b' }, () => ps.updateProspectSettings(B, { userId: 'usr_b', role: 'admin' }, full));
    const rowB = await runWithTenantContext({ tenantId: B, userId: 'usr_b' }, () => ps.getProspectSettings(B));
    check('settings: update upserts when no row', upB.ok && rowB.claimDays === 30, { upB, rowB });

    const bad = await Promise.all([
      { ...full, claimDays: 0 }, { ...full, claimDays: 91 }, { ...full, claimDays: 1.5 },
      { ...full, autoParkDays: 6 }, { ...full, autoParkDays: 366 },
    ].map((i) => asU(ownerU, () => ps.updateProspectSettings(A, owner, i))));
    const backBad = await asU(ownerU, () => ps.getProspectSettings(A));
    check('settings: out of range rejected', bad.every((r) => !r.ok && r.error === 'invalid') && backBad.claimDays === 30 && backBad.autoParkDays === 60, { bad, backBad });

    const denied = await asU(memberU, () => ps.updateProspectSettings(A, member, { ...full, claimDays: 5 }));
    const mgrDenied = await asU(mgrU, () => ps.updateProspectSettings(A, mgr, { ...full, claimDays: 5 }));
    const backDenied = await asU(ownerU, () => ps.getProspectSettings(A));
    check('settings: member denied', !denied.ok && denied.error === 'no_permission' && !mgrDenied.ok && mgrDenied.error === 'no_permission' && backDenied.claimDays === 30, { denied, mgrDenied, backDenied });

    await asU(ownerU, () => ps.updateProspectSettings(A, owner, { ...full, claimDays: 7, claimExpiryEnabled: false }));
    const kn = await mk('Claim No Expiry');
    const tNoExp = new Date();
    const knr = await asU(memberU, () => cl.claimProspect(A, member, kn, tNoExp));
    const knRow = await row(kn);
    const farFuture = new Date(tNoExp.getTime() + 3650 * DAY);
    check('claim: expiry disabled → claim_expires_at null and claim stays active', knr.ok && knRow.claimedBy === memberU && knRow.claimExpiresAt === null && rules.isClaimActive(knRow, farFuture), { knr, exp: knRow.claimExpiresAt });
    const kn2 = await mk('Reassign No Expiry');
    const kn2r = await asU(ownerU, () => cl.reassignClaim(A, owner, kn2, memberU, tNoExp));
    const kn2Row = await row(kn2);
    check('reassign: expiry disabled → claim_expires_at null', kn2r.ok && kn2Row.claimedBy === memberU && kn2Row.claimExpiresAt === null, { kn2r, exp: kn2Row.claimExpiresAt });
    await asU(ownerU, () => ps.updateProspectSettings(A, owner, { ...full, claimDays: 7, claimExpiryEnabled: true }));

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
    // Mirrors updateCommentAction/deleteCommentAction: touch first, write only when 'ok', same transaction.
    const editComment = (pid: string, cid: string, body: string) =>
      inA(async (tx) => {
        const r = await act.touchProspectActivity(tx, A, pid);
        if (r === 'ok') await tx.update(s.comments).set({ body }).where(eq(s.comments.id, cid));
        return r;
      });
    const mkComment = async (pid: string) =>
      (await inA((tx) => tx.insert(s.comments).values({ tenantId: A, entityType: 'prospect', entityId: pid, authorUserId: memberU, body: 'orig' }).returning()))[0]!.id;
    const cmtP = await mkComment(vpro);
    const er = await editComment(vpro, cmtP, 'changed');
    const cBody = (await inA((tx) => tx.select().from(s.comments).where(eq(s.comments.id, cmtP))))[0]!.body;
    check('touch: comment edit on promoted -> read_only, comment unchanged', er === 'read_only' && cBody === 'orig', { er, cBody });
    const actv = await mk('Edit Active', { lastActivityAt: new Date(Date.now() - 10 * DAY) });
    const cmtA = await mkComment(actv);
    const lastBefore2 = (await row(actv)).lastActivityAt!.getTime();
    const ea = await editComment(actv, cmtA, 'changed');
    const cBody2 = (await inA((tx) => tx.select().from(s.comments).where(eq(s.comments.id, cmtA))))[0]!.body;
    check('touch: edit on active prospect bumps last_activity_at', ea === 'ok' && cBody2 === 'changed' && (await row(actv)).lastActivityAt!.getTime() > lastBefore2 + DAY, { ea, cBody2 });

    /* ---------------- imports (Stage 2 Task 6) ---------------- */
    const imp = await import('../src/lib/prospects/import/imports');
    const { normalizeCompanyName } = await import('../src/lib/dedup/normalize');
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used'; // Claude is always stubbed below
    const dumpRow = (o: Record<string, unknown> = {}) => ({
      companyName: 'Dump Co', contactName: null, contactDesignation: null, contactEmail: null, contactPhone: null,
      domain: null, industry: null, sizeBand: null, city: null, state: null, clusterTags: [], notes: null,
      confidence: 0.9, note: null, ...o,
    });
    const stubParse = (rows: unknown[]) => ({
      create: (async () => ({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify({ rows }), citations: null }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      })) as never,
    });
    const failParse = { create: (async () => { throw new Error('boom'); }) as never };
    const importRow = async (id: string) => (await inA((tx) => tx.select().from(s.prospectImports).where(eq(s.prospectImports.id, id))))[0];
    const importCount = async () => (await inA((tx) => tx.select({ id: s.prospectImports.id }).from(s.prospectImports))).length;
    const prospectCount = async () => (await inA((tx) => tx.select({ id: s.prospects.id }).from(s.prospects))).length;

    const it1 = await asA(() => imp.createImport(A, member, { sourceTag: 'expo-26', kind: 'text', text: 'Dump Co and Two Co met at the expo' }, stubParse([dumpRow(), dumpRow({ companyName: 'Two Co' })])));
    const it1row = it1.ok ? await importRow(it1.importId) : undefined;
    check('import: text parsed and stored', it1.ok && it1.rows.length === 2 && it1row?.status === 'parsed' && (it1row?.parserOutput as unknown[]).length === 2 && it1row?.rowsParsed === 2 && it1row?.rawText === 'Dump Co and Two Co met at the expo' && it1row?.sourceTag === 'expo-26' && it1row?.createdBy === memberU && it1row?.parserModel === 'claude-opus-5-5', { it1, it1row });

    const ifl = await asA(() => imp.createImport(A, member, { sourceTag: 'expo-26', kind: 'text', text: 'Some dump' }, failParse));
    const failedRows = (await inA((tx) => tx.select().from(s.prospectImports).where(eq(s.prospectImports.status, 'failed'))));
    check('import: parse failure stored as failed', !ifl.ok && failedRows.length === 1 && !!failedRows[0]!.error && failedRows[0]!.rawText === 'Some dump' && failedRows[0]!.rowsParsed === 0, { ifl, failedRows });

    const n0 = await importCount();
    const ins = await asA(() => imp.createImport(A, member, { sourceTag: '  ', kind: 'text', text: 'Dump Co' }, stubParse([dumpRow()])));
    const ins2 = await asA(() => imp.createImport(A, member, { sourceTag: 'x'.repeat(81), kind: 'text', text: 'Dump Co' }, stubParse([dumpRow()])));
    check('import: missing sourceTag rejected, no row', !ins.ok && !ins2.ok && (await importCount()) === n0, { ins, ins2 });

    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const iimg = await asA(() => imp.createImport(A, member, { sourceTag: 'cards', kind: 'image', file: { bytes: big, mediaType: 'image/png', name: 'card.png' } }, stubParse([dumpRow()])));
    const ilong = await asA(() => imp.createImport(A, member, { sourceTag: 'cards', kind: 'text', text: 'a'.repeat(60_001) }, stubParse([dumpRow()])));
    const icsv = await asA(() => imp.createImport(A, member, { sourceTag: 'cards', kind: 'csv', file: { bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 97), mediaType: 'text/csv', name: 'a.csv' } }, stubParse([dumpRow()])));
    const igif = await asA(() => imp.createImport(A, member, { sourceTag: 'cards', kind: 'image', file: { bytes: Buffer.from('x'), mediaType: 'image/tiff', name: 'a.tif' } }, stubParse([dumpRow()])));
    check('import: 6MB image rejected', !iimg.ok && iimg.status === 413 && (await importCount()) === n0, iimg);
    check('import: 60,001-char text, 4MB+ CSV and tiff rejected, no row', !ilong.ok && ilong.status === 413 && !icsv.ok && icsv.status === 413 && !igif.ok && igif.status === 400 && (await importCount()) === n0, { ilong, icsv, igif });

    const viewerImp = await asA(() => imp.createImport(A, viewer, { sourceTag: 'x', kind: 'text', text: 'Dump Co' }, stubParse([dumpRow()])));
    check('import: viewer denied, no row', !viewerImp.ok && viewerImp.status === 403 && (await importCount()) === n0, viewerImp);

    const img = await asA(() => imp.createImport(A, member, { sourceTag: 'cards', kind: 'image', file: { bytes: Buffer.from('png'), mediaType: 'image/png', name: 'card.png' } }, { ...stubParse([dumpRow({ companyName: 'Card Co' })]), upload: async () => { throw new Error('storage down'); } }));
    const imgRow = img.ok ? await importRow(img.importId) : undefined;
    check('import: image parsed even when upload fails, raw_file_path null', img.ok && imgRow?.status === 'parsed' && imgRow?.rawFilePath === null && imgRow?.rawText === null, { img, imgRow });

    const csvBody = 'Company,Email\nCsv One,a@csv1.in\nCsv Two,b@csv2.in\n';
    const csvImp = await asA(() => imp.createImport(A, member, { sourceTag: 'csv-list', kind: 'csv', file: { bytes: Buffer.from(csvBody), mediaType: 'text/csv', name: 'l.csv' } }, failParse));
    const csvRow = csvImp.ok ? await importRow(csvImp.importId) : undefined;
    check('import: csv mapped without Claude, raw_text stored', csvImp.ok && csvImp.rows.length === 2 && csvRow?.rawText === csvBody && csvRow?.parserModel === null, { csvImp, csvRow });

    // hints: a seeded company + a seeded prospect share the name; domain/email/phone hit a company/contact.
    await mk('Hintco Industries');
    await inA(async (tx) => {
      const [co] = await tx.insert(s.companies).values({ tenantId: A, name: 'Hintco Industries', normalizedName: normalizeCompanyName('Hintco Industries') }).returning();
      await tx.insert(s.companies).values({ tenantId: A, name: 'Domainly', domain: 'https://www.domainly.in/', normalizedName: normalizeCompanyName('Domainly') });
      await tx.insert(s.contacts).values({ tenantId: A, firstName: 'Priya', lastName: 'Shah', email: 'Priya@Mailed.in', phone: '+91 98765 43210', phoneNormalized: '+919876543210', companyId: co!.id } as never);
    });
    const ih = await asA(() => imp.createImport(A, member, { sourceTag: 'hints', kind: 'text', text: 'hint dump' }, stubParse([
      dumpRow({ companyName: 'Hintco Industries' }),
      dumpRow({ companyName: 'Zzqx Unrelated', domain: 'domainly.in' }),
      dumpRow({ companyName: 'Yyqv Unrelated', contactEmail: 'priya@mailed.in' }),
      dumpRow({ companyName: 'Wwqk Unrelated', contactPhone: '098765 43210' }),
      dumpRow({ companyName: 'Vvqj Nothing' }),
    ])));
    const hk = (i: number) => (ih.ok ? ih.hints.filter((h) => h.index === i).map((h) => h.kind).sort().join(',') : '');
    check('import: hints', ih.ok && hk(0) === 'company,prospect' && hk(1) === 'company' && hk(2) === 'contact' && hk(3) === 'contact' && hk(4) === '', ih.ok ? ih.hints : ih);
    check('dedup: findCompanyByDomain / findContactByPhone', ih.ok && ih.hints.some((h) => h.index === 1 && h.label === 'Domainly') && ih.hints.some((h) => h.index === 3 && h.label === 'Priya Shah'), ih.ok ? ih.hints : ih);
    check(
      'import: hint labels (batched lookups)',
      ih.ok &&
        JSON.stringify(ih.hints) ===
          JSON.stringify([
            { index: 0, kind: 'prospect', label: 'Hintco Industries' },
            { index: 0, kind: 'company', label: 'Hintco Industries' },
            { index: 1, kind: 'company', label: 'Domainly' },
            { index: 2, kind: 'contact', label: 'Priya Shah' },
            { index: 3, kind: 'contact', label: 'Priya Shah' },
          ]),
      ih.ok ? ih.hints : ih,
    );
    // Fuzzy company-name search still runs for rows with no exact hit, but only in the first 100 rows.
    const { computeDedupHints } = await import('../src/lib/prospects/import/dedup-hints');
    const fuzzyRows = [dumpRow({ companyName: 'Hintco Zebra' }), ...Array.from({ length: 100 }, (_, i) => dumpRow({ companyName: `Qqzz Filler ${i}` })), dumpRow({ companyName: 'Hintco Zebra' })];
    const fh = await asA(() => computeDedupHints(A, fuzzyRows as never));
    check('hints: fuzzy match in the first 100 rows only', fh.some((h) => h.index === 0 && h.kind === 'company' && h.label === 'Hintco Industries') && !fh.some((h) => h.index === 101 && h.kind === 'company'), fh);

    // confirm
    const before1 = await prospectCount();
    const cf = it1.ok ? await asA(() => imp.confirmImport(A, member, it1.importId, it1.rows)) : null;
    const inserted = await inA((tx) => tx.select().from(s.prospects).where(eq(s.prospects.importId, it1.ok ? it1.importId : A)));
    const hist1 = inserted.length ? await hist(inserted[0]!.id) : [];
    const cfRow = it1.ok ? await importRow(it1.importId) : undefined;
    check('confirm: inserts with import_id + history', !!cf?.ok && cf.inserted === 2 && inserted.length === 2 && (await prospectCount()) === before1 + 2 && inserted.every((p) => p.sourceTag === 'expo-26' && p.stage === 'dump' && p.createdBy === memberU) && hist1.length === 1 && hist1[0]!.fromStage === null && hist1[0]!.toStage === 'dump' && hist1[0]!.changedBy === memberU && cfRow?.status === 'confirmed' && cfRow?.rowsInserted === 2 && !!cfRow?.confirmedAt, { cf, n: inserted.length, cfRow });

    const it2 = await asA(() => imp.createImport(A, member, { sourceTag: 'twice', kind: 'text', text: 'twice' }, stubParse([dumpRow({ companyName: 'Twice Co' })])));
    const before2 = await prospectCount();
    const [ca, cb] = it2.ok
      ? await Promise.all([
          asA(() => imp.confirmImport(A, member, it2.importId, it2.rows)),
          asA(() => imp.confirmImport(A, member, it2.importId, it2.rows)),
        ])
      : [null, null];
    const okN = [ca, cb].filter((r) => r?.ok).length;
    const loser = [ca, cb].find((r) => r && !r.ok);
    check('confirm: twice', okN === 1 && !!loser && !loser.ok && loser.message === 'This import was already confirmed or discarded.' && (await prospectCount()) === before2 + 1, { ca, cb });

    const it3 = await asA(() => imp.createImport(A, member, { sourceTag: 'invalid', kind: 'text', text: 'inv' }, stubParse([dumpRow({ companyName: 'Valid Co' }), dumpRow({ companyName: 'Other Valid' })])));
    const before3 = await prospectCount();
    const ci = it3.ok ? await asA(() => imp.confirmImport(A, member, it3.importId, [it3.rows[0], { ...it3.rows[1], companyName: '' }])) : null;
    check('confirm: invalid row rejects all with rowErrors', !!ci && !ci.ok && ci.rowErrors?.length === 1 && ci.rowErrors[0]!.index === 1 && (await prospectCount()) === before3 && (it3.ok ? (await importRow(it3.importId))?.status === 'parsed' : false), ci);

    const cx = it3.ok ? await asB(() => imp.confirmImport(B, { userId: 'usr_b', role: 'member' }, it3.importId, it3.rows)) : null;
    const dx = it3.ok ? await asB(() => imp.discardImport(B, { userId: 'usr_b', role: 'member' }, it3.importId)) : null;
    const cmal = await asA(() => imp.confirmImport(A, member, 'abc', []));
    check('confirm: cross-tenant import id -> not found', !!cx && !cx.ok && cx.message === 'Import not found.' && !!dx && !dx.ok && dx.message === 'Import not found.' && !cmal.ok && (await prospectCount()) === before3 && (it3.ok ? (await importRow(it3.importId))?.status === 'parsed' : false), { cx, dx, cmal });

    // Confirm: a row with another tenant's offering -> rowErrors for that row, nothing inserted.
    const before4 = await prospectCount();
    const cfo = it3.ok
      ? await asA(() => imp.confirmImport(A, member, it3.importId, [{ ...it3.rows[0], productFitOfferingId: offA!.id }, { ...it3.rows[1], productFitOfferingId: offB!.id }]))
      : null;
    check(
      'confirm: other tenant\'s offering -> rowErrors, nothing inserted',
      !!cfo && !cfo.ok && cfo.rowErrors?.length === 1 && cfo.rowErrors[0]!.index === 1 && cfo.rowErrors[0]!.message === 'Unknown product.' && (await prospectCount()) === before4 && (it3.ok ? (await importRow(it3.importId))?.status === 'parsed' : false),
      cfo,
    );

    // Rows past 500 are reported as capped, apart from dropped ones.
    const icap = await asA(() =>
      imp.createImport(A, member, { sourceTag: 'cap', kind: 'text', text: 'many' }, stubParse([...Array.from({ length: 600 }, (_, i) => dumpRow({ companyName: `Cap Co ${i}` })), dumpRow({ companyName: '' })])),
    );
    check('import: capped reported apart from dropped', icap.ok && icap.rows.length === 500 && icap.capped === 100 && icap.dropped === 1, icap.ok ? { n: icap.rows.length, c: icap.capped, d: icap.dropped } : icap);

    const dd = it3.ok ? await asA(() => imp.discardImport(A, member, it3.importId)) : null;
    const cd = it3.ok ? await asA(() => imp.confirmImport(A, member, it3.importId, it3.rows)) : null;
    check('discard: then confirm refused', !!dd?.ok && !!cd && !cd.ok && cd.message === 'This import was already confirmed or discarded.' && (it3.ok ? (await importRow(it3.importId))?.status === 'discarded' : false) && (await prospectCount()) === before3, { dd, cd });

    // ---- promote candidates ----
    {
      const { findPromoteCandidates } = await import('../src/lib/prospects/promote/match');
      const acme = await inA(async (tx) => (await tx.insert(s.companies).values({ tenantId: A, name: 'Acme Steel Pvt Ltd', normalizedName: 'acme steel', domain: 'acme.in' }).returning())[0]!);
      await inA((tx) => tx.insert(s.contacts).values({ tenantId: A, companyId: acme.id, firstName: 'Ravi', lastName: 'K', email: 'ravi@acme.in', phone: '+919845012345', phoneNormalized: '+919845012345' }));
      await inA((tx) => tx.insert(s.deals).values({ tenantId: A, name: 'Kaveri lead', stage: 'lead', companyNameText: 'Kaveri Textiles' }));
      await (runWithSystemContext(B, () => tenantTransaction((tx) => tx.insert(s.companies).values({ tenantId: B, name: 'Acme Steel B', normalizedName: 'acme steel', domain: 'acme.in' }))) as Promise<unknown>);
      await inA((tx) => tx.insert(s.companies).values({ tenantId: A, name: 'Gone Corp', normalizedName: 'gone', deletedAt: new Date() }));
      const pc = (o: Record<string, unknown>) => ({ ...p, companyName: 'Zed', normalizedName: 'zed', domain: null, emailNormalized: null, phoneNormalized: null, ...o }) as typeof p;
      const strongCo = (c: Array<{ kind: string; strength: string; id: string }>) => c.some((x) => x.kind === 'company' && x.strength === 'strong' && x.id === acme.id);
      const byName = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Acme Steel', normalizedName: 'acme steel' })));
      check('promote match: strong company by name', strongCo(byName) && byName.find((x) => x.id === acme.id)?.reason === 'name', byName);
      const byDom = await asA(() => findPromoteCandidates(A, pc({ domain: 'www.acme.in' })));
      check('promote match: strong by domain', byDom.some((x) => x.id === acme.id && x.strength === 'strong' && x.reason === 'domain'), byDom);
      const byMail = await asA(() => findPromoteCandidates(A, pc({ emailNormalized: 'ravi@acme.in' })));
      check('promote match: strong contact by email', byMail.some((x) => x.kind === 'contact' && x.strength === 'strong' && x.reason === 'email'), byMail);
      const byPh = await asA(() => findPromoteCandidates(A, pc({ phoneNormalized: '+919845012345' })));
      check('promote match: strong contact by phone', byPh.some((x) => x.kind === 'contact' && x.strength === 'strong' && x.reason === 'phone'), byPh);
      const byLead = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Kaveri Textiles Ltd', normalizedName: 'kaveri textiles' })));
      const lead = byLead.find((x) => x.kind === 'open_lead');
      check('promote match: strong open lead', !!lead && lead.strength === 'strong' && lead.label === 'Kaveri lead' && lead.sublabel === 'Unassigned', byLead);
      const weak = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Acme Engineering', normalizedName: 'acme engineering' })));
      check('promote match: weak fuzzy only', weak.length > 0 && weak.every((x) => x.strength === 'weak') && weak.some((x) => x.id === acme.id && x.reason === 'fuzzy_name'), weak);
      const dupe = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Acme Steel', normalizedName: 'acme steel', domain: 'acme.in' })));
      check('promote match: dedup keeps strongest', dupe.filter((x) => x.id === acme.id && x.kind === 'company').length === 1 && dupe.find((x) => x.id === acme.id)?.strength === 'strong', dupe);
      const cross = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Acme Steel', normalizedName: 'acme steel' })));
      check('promote match: cross-tenant not returned', cross.every((x) => x.label !== 'Acme Steel B'), cross);
      const gone = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Gone Corp', normalizedName: 'gone' })));
      check('promote match: soft-deleted not returned', gone.every((x) => x.label !== 'Gone Corp'), gone);
      // fix round 1: lookups use the caller's transaction; no cap on open-lead text matches.
      const inTx = await inA(async (tx) => {
        await tx.insert(s.companies).values({ tenantId: A, name: 'Txn Only Works', normalizedName: 'txn only works' });
        return findPromoteCandidates(A, pc({ companyName: 'Txn Only Works', normalizedName: 'txn only works' }), tx);
      });
      check('promote match: sees caller transaction writes', inTx.some((x) => x.kind === 'company' && x.strength === 'strong' && x.label === 'Txn Only Works'), inTx);
      await inA((tx) => tx.insert(s.deals).values(Array.from({ length: 60 }, (_, i) => ({ tenantId: A, name: `Shree lead ${i}`, stage: 'lead' as const, companyNameText: `Shree Filler ${i}` }))));
      await inA((tx) => tx.insert(s.deals).values({ tenantId: A, name: 'Balaji lead', stage: 'lead', companyNameText: 'Shree Balaji Traders' }));
      const shree = await asA(() => findPromoteCandidates(A, pc({ companyName: 'Shree Balaji Traders Pvt Ltd', normalizedName: 'shree balaji traders' })));
      check('promote match: exact open lead found past 60 same-word leads', shree.some((x) => x.kind === 'open_lead' && x.label === 'Balaji lead'), shree);
    }

    /* ---------------- promote (Stage 3 Task 2) — clean tenant C ---------------- */
    {
      const pr = await import('../src/lib/prospects/promote/promote');
      const { distributeLead } = await import('../src/lib/lead-capture/distribute');
      const inC = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
        runWithSystemContext(C, () => tenantTransaction(fn as never)) as Promise<T>;
      const cMember = { userId: `usr_cmem_${stamp}`, role: 'member' as const };
      const cOther = { userId: `usr_coth_${stamp}`, role: 'member' as const };
      const cMgr = { userId: `usr_cmgr_${stamp}`, role: 'manager' as const };
      const cOwner = { userId: `usr_cown_${stamp}`, role: 'owner' as const };
      const cGhost = `usr_cghost_${stamp}`;
      await inC((tx) =>
        tx.insert(s.memberships).values([
          { tenantId: C, userId: cMember.userId, role: 'member' },
          { tenantId: C, userId: cOther.userId, role: 'member' },
          { tenantId: C, userId: cMgr.userId, role: 'manager' },
          { tenantId: C, userId: cOwner.userId, role: 'owner' },
          { tenantId: C, userId: cGhost, role: 'member', status: 'suspended' as never },
        ] as never),
      );
      await db.execute(sql`INSERT INTO users (id, email, first_name, last_name) VALUES (${cMember.userId}, ${`${cMember.userId}@example.test`}, 'Mona', 'Member') ON CONFLICT DO NOTHING`);
      const events: string[] = [];
      const sendEvent = (async (name: string) => { events.push(name); }) as never;
      let distributeCalls = 0;
      const spyDistribute = ((args: Parameters<typeof distributeLead>[0]) => { distributeCalls++; return distributeLead(args); }) as typeof distributeLead;
      const deps = { sendEvent, distribute: spyDistribute };
      const asC = <T,>(uid: string, fn: () => Promise<T>) => runWithTenantContext({ tenantId: C, userId: uid }, fn);
      const promote = (actor: { userId: string; role: 'member' | 'manager' | 'owner' }, id: string, choice?: Record<string, unknown>, d: Record<string, unknown> = deps) =>
        asC(actor.userId, () => pr.promoteProspect(C, actor, id, choice as never, undefined, d as never));
      const [offC] = await inC((tx) => tx.insert(s.offerings).values({ tenantId: C, name: 'Solar Panels', category: s.offeringCategory.enumValues[0] }).returning());
      const mkC = async (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const r = await asC(cMember.userId, () => m.createProspect(C, cMember, { sourceTag: 'expo-26', clusterTags: [], ...input } as never));
        if (!r.ok) throw new Error(`create failed: ${r.error}`);
        if (Object.keys(extra).length) await inC((tx) => tx.update(s.prospects).set(extra as never).where(eq(s.prospects.id, r.id)));
        return r.id;
      };
      const prow = async (id: string) => (await inC((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, id))))[0]!;
      const dealsFrom = (pid: string) => inC((tx) => tx.select().from(s.deals).where(eq(s.deals.sourceProspectId, pid)));
      const dealById = async (id: string) => (await inC((tx) => tx.select().from(s.deals).where(eq(s.deals.id, id))))[0];
      const companiesNamed = (norm: string) => inC((tx) => tx.select().from(s.companies).where(eq(s.companies.normalizedName, norm)));
      const notesOn = (dealId: string) => inC((tx) => tx.select().from(s.notes).where(eq(s.notes.entityId, dealId)).orderBy(s.notes.createdAt));

      // 1. clean promote: company + contact + lead with every field
      const pClean = await mkC({
        companyName: 'Nirvana Polymers', domain: 'https://www.nirvana.in/', industry: 'Plastics',
        contactName: 'Anil Kumar Mehta', contactDesignation: 'Purchase Head', contactEmail: 'Anil@Nirvana.in', contactPhone: '098450 11111',
        city: 'Pune', state: 'Maharashtra', productFitOfferingId: offC!.id, notes: 'Met at expo, wants a quote',
      });
      await inC((tx) => tx.insert(s.comments).values([
        { tenantId: C, entityType: 'prospect', entityId: pClean, authorUserId: cMember.userId, body: 'Called, call back Monday' },
        { tenantId: C, entityType: 'prospect', entityId: pClean, authorUserId: cMember.userId, body: 'Sent brochure' },
      ]));
      const o1 = await promote(cMember, pClean);
      const d1s = await dealsFrom(pClean);
      const d1 = d1s[0];
      const co1 = d1?.companyId ? (await inC((tx) => tx.select().from(s.companies).where(eq(s.companies.id, d1.companyId!))))[0] : undefined;
      const ct1 = d1?.contactId ? (await inC((tx) => tx.select().from(s.contacts).where(eq(s.contacts.id, d1.contactId!))))[0] : undefined;
      const src1 = d1?.leadSourceId ? (await inC((tx) => tx.select().from(s.leadSources).where(eq(s.leadSources.id, d1.leadSourceId!))))[0] : undefined;
      const p1 = await prow(pClean);
      const act1 = d1 ? await inC((tx) => tx.select().from(s.activityLogs).where(eq(s.activityLogs.entityId, d1.id))) : [];
      check(
        'promote: clean prospect creates company+contact+lead with all fields',
        o1.status === 'promoted' && !o1.linked && d1s.length === 1 && o1.dealId === d1!.id &&
          d1!.stage === 'lead' && d1!.source === 'Prospect Board: expo-26' && d1!.companyNameText === 'Nirvana Polymers' &&
          d1!.leadCity === 'Pune' && d1!.leadState === 'Maharashtra' && d1!.leadProductInterest === 'Solar Panels' && d1!.sourceProspectId === pClean &&
          src1?.type === 'prospect_board' && src1?.name === 'Prospect Board' &&
          co1?.name === 'Nirvana Polymers' && co1?.normalizedName === 'nirvana polymers' && co1?.domain === 'nirvana.in' && co1?.industry === 'Plastics' && co1?.dedupOverride === false &&
          ct1?.firstName === 'Anil' && ct1?.lastName === 'Kumar Mehta' && ct1?.title === 'Purchase Head' && ct1?.email === 'Anil@Nirvana.in' &&
          ct1?.emailNormalized === 'anil@nirvana.in' && ct1?.phoneNormalized === '+919845011111' && ct1?.companyId === co1?.id &&
          p1.promotedDealId === d1!.id && !!p1.promotedAt && p1.promotedBy === cMember.userId &&
          act1.some((a) => a.action === 'automation_note' && (a.metadata as { message?: string }).message === 'Promoted from Prospect Board'),
        { o1, d1, co1, ct1, src1, p1: { d: p1.promotedDealId, by: p1.promotedBy }, act1: act1.map((a) => a.action) },
      );
      const n1 = d1 ? await notesOn(d1.id) : [];
      const cmts = n1.filter((n) => n.body.startsWith('Comment by Mona Member on '));
      check(
        'promote: notes + comments copied as notes with the prefix',
        n1.length === 3 && n1.some((n) => n.body === 'Met at expo, wants a quote') && cmts.length === 2 && cmts.some((n) => n.body.endsWith('Called, call back Monday')) && n1.every((n) => n.entityType === 'deal'),
        n1.map((n) => n.body),
      );
      check(
        'promote: unclaimed → distributeLead called',
        o1.status === 'promoted' && ['distributed', 'unassigned', 'queued'].includes(o1.routing) && distributeCalls === 1,
        { o1, distributeCalls },
      );
      check('promote: post-commit events fired', events.includes('crm/deal.created') && events.includes('crm/company.created') && events.includes('crm/contact.created'), events);

      // 3. claimed → claimer owns the lead
      const pClaimed = await mkC({ companyName: 'Claimwell Exports', contactEmail: 'ops@claimwell.in' }, { claimedBy: cOther.userId, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
      const callsBefore = distributeCalls;
      const o3 = await promote(cOther, pClaimed);
      const d3 = o3.status === 'promoted' ? await dealById(o3.dealId) : undefined;
      const la3 = d3 ? await inC((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, d3.id))) : [];
      check(
        'promote: claimed → lead owner is claimer, an open lead_assignments row exists',
        o3.status === 'promoted' && o3.routing === 'claimer' && d3?.ownerId === cOther.userId && la3.some((a) => a.assignedTo === cOther.userId && a.releasedAt === null) && distributeCalls === callsBefore,
        { o3, owner: d3?.ownerId, la3 },
      );
      // claimer suspended since claiming → falls back to distribution, never to the claimer
      const pGhost = await mkC({ companyName: 'Ghostline Pumps', contactEmail: 'a@ghostline.in' }, { claimedBy: cGhost, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
      const oG = await promote(cOwner, pGhost);
      const dG = oG.status === 'promoted' ? await dealById(oG.dealId) : undefined;
      check('promote: suspended claimer → distributed instead', oG.status === 'promoted' && oG.routing !== 'claimer' && oG.routing !== 'retry' && dG?.ownerId !== cGhost, { oG, owner: dG?.ownerId });

      // 5. strong match → blocked, nothing written
      await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Blocker Industries', normalizedName: normalizeCompanyName('Blocker Industries') }));
      const pBlock = await mkC({ companyName: 'Blocker Industries', contactEmail: 'x@blocker.in' });
      const coBefore = (await inC((tx) => tx.select({ id: s.companies.id }).from(s.companies))).length;
      const o5 = await promote(cMember, pBlock);
      const coAfter = (await inC((tx) => tx.select({ id: s.companies.id }).from(s.companies))).length;
      check(
        'promote: strong match → blocked, nothing written',
        o5.status === 'blocked' && o5.candidates.some((c) => c.kind === 'company' && c.strength === 'strong') && (await dealsFrom(pBlock)).length === 0 && (await prow(pBlock)).promotedDealId === null && coAfter === coBefore,
        { o5, coBefore, coAfter },
      );

      // 6. weak only → warn; ignoreWarnings → promoted
      await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Zentrix Steel', normalizedName: 'zentrix steel' }));
      const pWeak = await mkC({ companyName: 'Zentrix Engineering', contactEmail: 'hi@zentrix-eng.in' });
      const o6a = await promote(cMember, pWeak);
      const o6b = await promote(cMember, pWeak, { ignoreWarnings: true });
      check(
        'promote: weak only → warn; with ignoreWarnings → promoted',
        o6a.status === 'warn' && o6a.candidates.length > 0 && o6a.candidates.every((c) => c.strength === 'weak') && o6b.status === 'promoted' && (await dealsFrom(pWeak)).length === 1,
        { o6a, o6b },
      );

      // 7. choose an existing company
      const [pick] = await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Pickme Traders', normalizedName: 'pickme traders' }).returning());
      const pPick = await mkC({ companyName: 'Pickme Traders', contactEmail: 'buy@pickme.in' });
      const o7 = await promote(cMember, pPick, { companyId: pick!.id });
      const d7 = (await dealsFrom(pPick))[0];
      check(
        'promote: choose existing company → deal.company_id = picked, no new company',
        o7.status === 'promoted' && d7?.companyId === pick!.id && (await companiesNamed('pickme traders')).length === 1,
        { o7, d7: d7?.companyId },
      );

      // 8. choose an open lead → linked
      const [openLead] = await inC((tx) => tx.insert(s.deals).values({ tenantId: C, name: 'Linkup lead', stage: 'lead', companyNameText: 'Linkup Foods' }).returning());
      const pLink = await mkC({ companyName: 'Linkup Foods', contactEmail: 'l@linkup.in', notes: 'Linked notes' });
      const nDealsBefore = (await inC((tx) => tx.select({ id: s.deals.id }).from(s.deals))).length;
      const o8 = await promote(cMember, pLink, { leadId: openLead!.id });
      const nDealsAfter = (await inC((tx) => tx.select({ id: s.deals.id }).from(s.deals))).length;
      const n8 = await notesOn(openLead!.id);
      const a8 = await inC((tx) => tx.select().from(s.activityLogs).where(eq(s.activityLogs.entityId, openLead!.id)));
      check(
        'promote: choose open lead → linked, no new deal, promoted_deal_id = that lead',
        o8.status === 'promoted' && o8.linked && o8.dealId === openLead!.id && nDealsAfter === nDealsBefore && (await prow(pLink)).promotedDealId === openLead!.id &&
          n8.some((n) => n.body === 'Linked notes') && a8.some((a) => (a.metadata as { message?: string }).message === 'Promoted from Prospect Board'),
        { o8, nDealsBefore, nDealsAfter, n8: n8.map((n) => n.body) },
      );
      // a second prospect cannot link the same lead (promoted_deal_id is unique)
      const pLink2 = await mkC({ companyName: 'Linkup Foods', contactEmail: 'l2@linkup.in' });
      const o8b = await promote(cMember, pLink2, { leadId: openLead!.id });
      check('promote: lead already linked to another prospect → invalid', o8b.status === 'error' && o8b.error === 'invalid' && (await prow(pLink2)).promotedDealId === null, o8b);

      // 9. create anyway
      await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Anyway Corp', normalizedName: 'anyway' }));
      const pAny = await mkC({ companyName: 'Anyway Corp', contactEmail: 'a@anyway.in' });
      const o9a = await promote(cMember, pAny, { createAnyway: true });
      const o9b = await promote(cMgr, pAny, { createAnyway: true });
      const d9 = (await dealsFrom(pAny))[0];
      const co9 = d9?.companyId ? (await inC((tx) => tx.select().from(s.companies).where(eq(s.companies.id, d9.companyId!))))[0] : undefined;
      check(
        'promote: createAnyway by member → no_permission; by manager → promoted with dedup_override',
        o9a.status === 'error' && o9a.error === 'no_permission' && o9b.status === 'promoted' && co9?.dedupOverride === true && (await companiesNamed('anyway')).length === 2,
        { o9a, o9b, co9 },
      );

      // 10. choice not among candidates
      const pStray = await mkC({ companyName: 'Strayfield Co', contactEmail: 's@strayfield.in' });
      const o10a = await promote(cMember, pStray, { companyId: pick!.id });
      const o10b = await promote(cMember, pStray, { contactId: '00000000-0000-0000-0000-000000000000' });
      check('promote: choice not among candidates → invalid', o10a.status === 'error' && o10a.error === 'invalid' && o10b.status === 'error' && o10b.error === 'invalid' && (await dealsFrom(pStray)).length === 0, { o10a, o10b });

      // 11. concurrent
      const pRace = await mkC({ companyName: 'Racecourse Mills', contactEmail: 'r@racecourse.in' });
      const [r1, r2] = await Promise.all([promote(cMember, pRace), promote(cMember, pRace)]);
      const okN = [r1, r2].filter((r) => r.status === 'promoted').length;
      const errN = [r1, r2].filter((r) => r.status === 'error' && r.error === 'promoted' && r.message === 'Already promoted to a lead.').length;
      check('promote: concurrent', okN === 1 && errN === 1 && (await dealsFrom(pRace)).length === 1, { r1, r2 });

      // 12. routing throws
      const pThrow = await mkC({ companyName: 'Throwaway Ceramics', contactEmail: 't@throwaway.in' });
      const o12 = await promote(cMember, pThrow, undefined, { sendEvent, distribute: (async () => { throw new Error('distribution down'); }) as never });
      const d12 = (await dealsFrom(pThrow))[0];
      check(
        'promote: routing throws',
        o12.status === 'promoted' && o12.routing === 'retry' && !!d12 && d12.routingStatus === 'pending' && !!d12.routingQueuedAt && (await prow(pThrow)).promotedDealId === d12.id,
        { o12, d12: d12 && { rs: d12.routingStatus, q: d12.routingQueuedAt } },
      );
      const srcC = await inC((tx) => tx.select().from(s.leadSources).where(eq(s.leadSources.type, 'prospect_board')));
      check('promote: lead source created once per tenant', srcC.length === 1, srcC.map((x) => x.name));

      // 13. reuse an admin-created prospect_board source (tenant A has one from the schema test)
      const srcA = await inA((tx) => tx.select().from(s.leadSources).where(eq(s.leadSources.type, 'prospect_board')));
      const pA = await mk('Qwzx Reuse Source', { contactEmail: 'q@qwzx.in', emailNormalized: 'q@qwzx.in' });
      const oA = await asA(() => pr.promoteProspect(A, member, pA, undefined, undefined, deps as never));
      const dA = oA.status === 'promoted' ? (await inA((tx) => tx.select().from(s.deals).where(eq(s.deals.id, oA.dealId))))[0] : undefined;
      const srcA2 = await inA((tx) => tx.select().from(s.leadSources).where(eq(s.leadSources.type, 'prospect_board')));
      check('promote: lead source reused when an admin-created prospect_board source exists', srcA.length === 1 && oA.status === 'promoted' && dA?.leadSourceId === srcA[0]!.id && srcA2.length === 1, { oA, src: dA?.leadSourceId, srcA: srcA.map((x) => x.id), n: srcA2.length });

      // manager scope over the claim holder: cOther reports to cMgr, cMember does not
      await inC((tx) => tx.update(s.memberships).set({ reportsToUserId: cMgr.userId } as never).where(eq(s.memberships.userId, cOther.userId)));
      const liveClaim = (by: string) => ({ claimedBy: by, claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + DAY) });
      const pOut = await mkC({ companyName: 'Outscope Valves', contactEmail: 'o@outscope.in' }, liveClaim(cMember.userId));
      const pIn = await mkC({ companyName: 'Inscope Valves', contactEmail: 'i@inscope.in' }, liveClaim(cOther.userId));
      const oOut = await promote(cMgr, pOut);
      const oIn = await promote(cMgr, pIn);
      const dIn = oIn.status === 'promoted' ? await dealById(oIn.dealId) : undefined;
      check(
        "promote: manager on out-of-team claim → out_of_scope; in-team → claimer owns it",
        oOut.status === 'error' && oOut.error === 'out_of_scope' && (await dealsFrom(pOut)).length === 0 && oIn.status === 'promoted' && oIn.routing === 'claimer' && dIn?.ownerId === cOther.userId,
        { oOut, oIn, owner: dIn?.ownerId },
      );

      // fix round 1 (I1/M1): picks must cover every kind with strong matches
      const countC = async () => ({
        co: (await inC((tx) => tx.select({ id: s.companies.id }).from(s.companies))).length,
        ct: (await inC((tx) => tx.select({ id: s.contacts.id }).from(s.contacts))).length,
      });
      const [kes] = await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Kestrel Pumps', normalizedName: normalizeCompanyName('Kestrel Pumps') }).returning());
      const [kesCt] = await inC((tx) => tx.insert(s.contacts).values({ tenantId: C, companyId: kes!.id, firstName: 'Kiran', email: 'k@kestrel.in', emailNormalized: 'k@kestrel.in' }).returning());
      const pKes = await mkC({ companyName: 'Kestrel Pumps', contactEmail: 'k@kestrel.in' });
      const oK1 = await promote(cMember, pKes, { companyId: kes!.id });
      check('promote: company picked while a strong email contact exists → blocked', oK1.status === 'blocked' && (await dealsFrom(pKes)).length === 0, oK1);
      const cnt0 = await countC();
      const oK2 = await promote(cMember, pKes, { companyId: kes!.id, contactId: kesCt!.id });
      const dK = (await dealsFrom(pKes))[0];
      const cnt1 = await countC();
      check(
        'promote: company + that contact picked → promoted, no new contact or company',
        oK2.status === 'promoted' && dK?.companyId === kes!.id && dK?.contactId === kesCt!.id && cnt1.co === cnt0.co && cnt1.ct === cnt0.ct,
        { oK2, cnt0, cnt1 },
      );
      await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Nomad Freight', normalizedName: normalizeCompanyName('Nomad Freight') }));
      const [nomCt] = await inC((tx) => tx.insert(s.contacts).values({ tenantId: C, companyId: null, firstName: 'Nina', email: 'n@nomad.in', emailNormalized: 'n@nomad.in' }).returning());
      const pNom = await mkC({ companyName: 'Nomad Freight', contactEmail: 'n@nomad.in' });
      const oN = await promote(cMember, pNom, { contactId: nomCt!.id });
      check('promote: contact without company picked while a strong company exists → blocked', oN.status === 'blocked' && (await dealsFrom(pNom)).length === 0, oN);
      const [orbis] = await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Orbis Chemicals', normalizedName: normalizeCompanyName('Orbis Chemicals') }).returning());
      const [orbisWeak] = await inC((tx) => tx.insert(s.companies).values({ tenantId: C, name: 'Orbis Textiles', normalizedName: normalizeCompanyName('Orbis Textiles') }).returning());
      const pOrb = await mkC({ companyName: 'Orbis Chemicals', contactEmail: 'o@orbis.in' });
      const oW = await promote(cMember, pOrb, { companyId: orbisWeak!.id });
      check('promote: weak pick while strong matches exist → blocked', oW.status === 'blocked' && oW.candidates.some((c) => c.id === orbisWeak!.id && c.strength === 'weak') && (await dealsFrom(pOrb)).length === 0, oW);
      const pMis = await mkC({ companyName: 'Orbis Chemicals', contactEmail: 'k@kestrel.in' });
      const oM = await promote(cMember, pMis, { companyId: orbis!.id, contactId: kesCt!.id });
      check('promote: mismatched company/contact pair → invalid', oM.status === 'error' && oM.error === 'invalid' && oM.message === 'That contact belongs to a different company.' && (await dealsFrom(pMis)).length === 0, oM);

      // fix round 1 (I2): the SLA watchdog never takes a claimer's lead back
      const sla = await import('../src/lib/lead-capture/sla');
      const [ctrl] = await inC((tx) => tx.insert(s.deals).values({ tenantId: C, name: 'Watchdog control', stage: 'lead', routingStatus: 'pending', routingQueuedAt: new Date() }).returning());
      await asC(cOwner.userId, () => sla.reassignLead({ tenantId: C, dealId: ctrl!.id, toUserId: cOther.userId, actorUserId: cOwner.userId, reason: 'control' }));
      const la3Before = d3 ? await inC((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, d3.id))) : [];
      const wd = await asC(cOwner.userId, () => sla.runSlaWatchdog(C, new Date(Date.now() + 2 * 3_600_000)));
      const la3After = d3 ? await inC((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, d3.id))) : [];
      const ctrlAfter = await inC((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, ctrl!.id)));
      const d3After = d3 ? await dealById(d3.id) : undefined;
      check(
        'promote: claimer keeps the lead past the SLA watchdog',
        la3Before.some((a) => a.releasedAt === null && a.firstTouchAt !== null) &&
          la3After.filter((a) => a.releasedAt === null).length === 1 && la3After.some((a) => a.releasedAt === null && a.assignedTo === cOther.userId) &&
          d3After?.ownerId === cOther.userId &&
          // control: an untouched manual assignment IS released by the same pass
          wd.breached >= 1 && ctrlAfter.some((a) => a.releaseReason === 'sla_breach'),
        { wd, la3After, ctrlAfter: ctrlAfter.map((a) => [a.releasedAt, a.releaseReason]) },
      );

      // 14. bulk
      const bClean = await mkC({ companyName: 'Bulkclean Agro', contactEmail: 'b@bulkclean.in' });
      const bBlock = await mkC({ companyName: 'Blocker Industries', contactEmail: 'b2@blocker.in' });
      const bPark = await mkC({ companyName: 'Parkside Tools', contactEmail: 'p@parkside.in' }, { stage: 'parked', parkedReason: 'manual' });
      const bk = await asC(cMember.userId, () => pr.bulkPromote(C, cMember, [bClean, bBlock, bPark, 'abc'], {}, deps as never));
      const st = bk.results.map((r) => (r.outcome.status === 'error' ? `error:${r.outcome.error}` : r.outcome.status));
      check('bulk: mixed', JSON.stringify(st) === JSON.stringify(['promoted', 'blocked', 'error:parked', 'error:not_found']) && bk.results.map((r) => r.id).join() === [bClean, bBlock, bPark, 'abc'].join(), { st, bk });
      const bkMany = await asC(cMember.userId, () => pr.bulkPromote(C, cMember, Array.from({ length: 101 }, () => bClean), {}, deps as never));
      check('bulk: over 100 ids → all invalid', bkMany.results.length === 101 && bkMany.results.every((r) => r.outcome.status === 'error' && r.outcome.error === 'invalid'), bkMany.results.length);

      // final review I3: promote supersedes the prospect's pending enrichment suggestions (create + link paths)
      const sugFor = (pid: string) => inC((tx) => tx.select().from(s.aiSuggestions).where(eq(s.aiSuggestions.entityId, pid)));
      const seedSug = (pid: string) =>
        inC((tx) =>
          tx.insert(s.aiSuggestions).values([
            { tenantId: C, entityType: 'prospect', entityId: pid, field: 'industry', suggestedValue: 'Textiles', evidenceQuote: 'r', sourceType: 'enrichment', sourceId: pid, confidence: 0.8, model: 'stub' },
            { tenantId: C, entityType: 'prospect', entityId: pid, field: 'icp_score', suggestedValue: 70, evidenceQuote: 'r', sourceType: 'enrichment', sourceId: pid, confidence: 0.8, model: 'stub', status: 'rejected', decidedAt: new Date(), decisionNote: 'no' },
          ] as never),
        );
      const pSug = await mkC({ companyName: 'Suggestive Looms', contactEmail: 's@suggestive.in' });
      await seedSug(pSug);
      const oSug = await promote(cMember, pSug);
      const sug1 = await sugFor(pSug);
      const pend1 = sug1.find((x) => x.field === 'industry');
      const rej1 = sug1.find((x) => x.field === 'icp_score');
      check(
        'promote (create): pending suggestions → superseded with note; decided ones untouched',
        oSug.status === 'promoted' && pend1?.status === 'superseded' && pend1.decisionNote === 'Prospect promoted to a lead' && !!pend1.decidedAt && rej1?.status === 'rejected' && rej1.decisionNote === 'no',
        { oSug, sug1: sug1.map((x) => [x.field, x.status, x.decisionNote]) },
      );
      const [openLead2] = await inC((tx) => tx.insert(s.deals).values({ tenantId: C, name: 'Suglink lead', stage: 'lead', companyNameText: 'Suglink Dyes' }).returning());
      const pSugL = await mkC({ companyName: 'Suglink Dyes', contactEmail: 'l@suglink.in' });
      await seedSug(pSugL);
      const oSugL = await promote(cMember, pSugL, { leadId: openLead2!.id });
      const sug2 = (await sugFor(pSugL)).find((x) => x.field === 'industry');
      check('promote (link): pending suggestions → superseded', oSugL.status === 'promoted' && oSugL.linked && sug2?.status === 'superseded' && sug2.decisionNote === 'Prospect promoted to a lead', { oSugL, sug2 });
      const pSugB = await mkC({ companyName: 'Blocker Industries', contactEmail: 'sb@blocker.in' });
      await seedSug(pSugB);
      const oSugB = await promote(cMember, pSugB);
      const sug3 = (await sugFor(pSugB)).find((x) => x.field === 'industry');
      check('promote blocked: suggestions stay pending', oSugB.status === 'blocked' && sug3?.status === 'pending', { oSugB: oSugB.status, sug3: sug3?.status });
    }

    /* ---------------- daily maintenance (Stage 3 Task 5) ---------------- */
    {
      const mt = await import('../src/lib/prospects/maintenance');
      const inD = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
        runWithSystemContext(D, () => tenantTransaction(fn as never)) as Promise<T>;
      const NOW = new Date('2026-06-01T12:00:00Z');
      const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
      const mkD = async (name: string, extra: Record<string, unknown> = {}) =>
        (await inD((tx) => tx.insert(s.prospects).values({ tenantId: D, companyName: name, sourceTag: 'maint', lastActivityAt: ago(1), stageChangedAt: ago(1), ...extra } as never).returning({ id: s.prospects.id })))[0]!.id;
      const rowD = async (id: string) => (await inD((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, id))))[0]!;
      const histD = (id: string) => inD((tx) => tx.select().from(s.prospectStageHistory).where(eq(s.prospectStageHistory.prospectId, id)));
      const setD = (v: { claimDays?: number; claimExpiryEnabled?: boolean; autoParkDays?: number; autoParkEnabled?: boolean }) =>
        inD((tx) => {
          const set = {
            ...(v.claimDays !== undefined && { prospectClaimDays: v.claimDays }),
            ...(v.claimExpiryEnabled !== undefined && { prospectClaimExpiryEnabled: v.claimExpiryEnabled }),
            ...(v.autoParkDays !== undefined && { prospectAutoParkDays: v.autoParkDays }),
            ...(v.autoParkEnabled !== undefined && { prospectAutoParkEnabled: v.autoParkEnabled }),
          };
          return tx.insert(s.organizationSettings).values({ tenantId: D, ...set }).onConflictDoUpdate({ target: s.organizationSettings.tenantId, set });
        });

      const stale = await mkD('Stale Co', { stage: 'researching', lastActivityAt: ago(50) });
      const recent = await mkD('Recent Co', { lastActivityAt: ago(40) });
      const promoted = await mkD('Promoted Old', { lastActivityAt: ago(90), promotedDealId: (await inD((tx) => tx.insert(s.deals).values({ tenantId: D, name: 'D deal' }).returning({ id: s.deals.id })))[0]!.id });
      const deleted = await mkD('Deleted Old', { lastActivityAt: ago(90), deletedAt: ago(5) });
      const parkedAlready = await mkD('Parked Old', { lastActivityAt: ago(90), stage: 'parked', parkedReason: 'manual', stageChangedAt: ago(70) });
      const staleLast = (await rowD(stale)).lastActivityAt;
      const r1 = await mt.runProspectMaintenance(D, NOW);
      const sRow = await rowD(stale);
      const sHist = await histD(stale);
      check('maint: parks stale', r1.parked === 1 && sRow.stage === 'parked' && sRow.parkedReason === 'stale' && sRow.stageChangedAt.getTime() === NOW.getTime() && sHist.length === 1 && sHist[0]!.changedBy === 'system:auto-park' && sHist[0]!.fromStage === 'researching' && sHist[0]!.toStage === 'parked', { r1, sRow, sHist });
      check('maint: keeps recent', (await rowD(recent)).stage === 'dump');
      const pRow = await rowD(promoted);
      const dRow = await rowD(deleted);
      const paRow = await rowD(parkedAlready);
      check('maint: skips promoted/deleted/parked', pRow.stage === 'dump' && dRow.stage === 'dump' && paRow.parkedReason === 'manual' && paRow.stageChangedAt.getTime() === ago(70).getTime() && (await histD(parkedAlready)).length === 0 && (await histD(promoted)).length === 0 && (await histD(deleted)).length === 0);
      check('maint: last_activity_at unchanged by park', sRow.lastActivityAt.getTime() === staleLast.getTime(), [staleLast, sRow.lastActivityAt]);
      const r2 = await mt.runProspectMaintenance(D, NOW);
      check('maint: rerun is no-op', r2.parked === 0 && r2.released === 0 && (await histD(stale)).length === 1, r2);

      await setD({ autoParkEnabled: false });
      const off = await mkD('Off Co', { lastActivityAt: ago(60) });
      const rOff = await mt.runProspectMaintenance(D, NOW);
      check('maint: auto-park disabled → none', rOff.parked === 0 && (await rowD(off)).stage === 'dump', rOff);
      await setD({ autoParkEnabled: true, autoParkDays: 10 });
      const c10 = await mkD('Ten Days Co', { lastActivityAt: ago(12) });
      const c10r = await mkD('Nine Days Co', { lastActivityAt: ago(8) });
      const rC = await mt.runProspectMaintenance(D, NOW);
      check('maint: custom days (10)', (await rowD(c10)).stage === 'parked' && (await rowD(c10r)).stage === 'dump' && (await rowD(recent)).stage === 'parked', rC);
      await setD({ autoParkDays: 45 });

      const claimer = `usr_claimer_${stamp}`;
      const expired = await mkD('Expired Claim Co', { claimedBy: claimer, claimedAt: ago(20), claimExpiresAt: ago(1) });
      const active = await mkD('Active Claim Co', { claimedBy: claimer, claimedAt: ago(1), claimExpiresAt: new Date(NOW.getTime() + 5 * DAY) });
      await setD({ claimExpiryEnabled: false });
      const rNoExp = await mt.runProspectMaintenance(D, NOW);
      check('maint: expiry disabled → no release', rNoExp.released === 0 && (await rowD(expired)).claimedBy === claimer, rNoExp);
      await setD({ claimExpiryEnabled: true });
      const rRel = await mt.runProspectMaintenance(D, NOW);
      const eRow = await rowD(expired);
      const notesD = await runWithTenantContext({ tenantId: D, userId: claimer }, () => tenantTransaction((tx) => tx.select().from(s.notifications).where(eq(s.notifications.recipientUserId, claimer))));
      const nx = notesD.filter((n) => n.type === 'prospect_claim_expired');
      check('maint: releases expired claim + notification row', rRel.released === 1 && eRow.claimedBy === null && eRow.claimedAt === null && eRow.claimExpiresAt === null && nx.length === 1 && nx[0]!.entityType === 'prospect' && nx[0]!.entityId === expired && nx[0]!.title === 'Your claim on Expired Claim Co expired', { rRel, eRow, nx });
      check('maint: keeps active claim', (await rowD(active)).claimedBy === claimer && (await rowD(active)).claimExpiresAt !== null);

      // boundaries: strict < for park, <= for release, and a park keeps the claim
      const bEdge = await mkD('Edge 45d Co', { lastActivityAt: ago(45) });
      const bClaimPark = await mkD('Claimed Stale Co', { lastActivityAt: ago(60), claimedBy: claimer, claimedAt: ago(1), claimExpiresAt: new Date(NOW.getTime() + 5 * DAY) });
      const bExact = await mkD('Exact Expiry Co', { claimedBy: claimer, claimedAt: ago(14), claimExpiresAt: NOW });
      // final review I1: a promoted prospect keeps its (expired) claim as attribution
      const promoDeal = (await inD((tx) => tx.insert(s.deals).values({ tenantId: D, name: 'Promoted claim deal' }).returning({ id: s.deals.id })))[0]!.id;
      const bPromoClaim = await mkD('Promoted Claim Co', { claimedBy: claimer, claimedAt: ago(20), claimExpiresAt: ago(3), promotedDealId: promoDeal, promotedAt: ago(5) });
      const rB = await mt.runProspectMaintenance(D, NOW);
      const pcRow = await rowD(bPromoClaim);
      const pcNotes = await runWithTenantContext({ tenantId: D, userId: claimer }, () =>
        tenantTransaction((tx) => tx.select().from(s.notifications).where(and(eq(s.notifications.recipientUserId, claimer), eq(s.notifications.entityId, bPromoClaim)))),
      );
      check('maint: claimed + promoted + expired → not released, no notification', pcRow.claimedBy === claimer && pcRow.claimExpiresAt !== null && pcNotes.length === 0, { pcRow: { by: pcRow.claimedBy, exp: pcRow.claimExpiresAt }, pcNotes: pcNotes.length });
      const cpRow = await rowD(bClaimPark);
      check('maint: exactly 45 days is not parked (strict <)', (await rowD(bEdge)).stage === 'dump' && rB.parked === 1, rB);
      check('maint: claim expiring exactly now is released (<=)', (await rowD(bExact)).claimedBy === null && rB.released === 1, rB);
      check('maint: auto-parked prospect keeps its claim', cpRow.stage === 'parked' && cpRow.claimedBy === claimer && cpRow.claimExpiresAt !== null, cpRow);
    }
    /* ---------------- enrichment (Stage 3 Task 6) ---------------- */
    {
      const en = await import('../src/lib/prospects/enrich');
      const eMember = { userId: `usr_enrich_${stamp}`, role: 'member' as const };
      const asE = <T,>(fn: () => Promise<T>) => runWithTenantContext({ tenantId: E, userId: eMember.userId }, fn);
      const sysE = <T,>(fn: () => Promise<T>) => runWithSystemContext(E, fn);
      const inE = <T,>(fn: (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) => Promise<T>) =>
        runWithSystemContext(E, () => tenantTransaction(fn as never)) as Promise<T>;
      const [offE] = await inE((tx) => tx.insert(s.offerings).values({ tenantId: E, name: 'Payroll Suite', category: s.offeringCategory.enumValues[0] }).returning());
      const [offRetired] = await inE((tx) => tx.insert(s.offerings).values({ tenantId: E, name: 'Old Product', category: s.offeringCategory.enumValues[0], active: false }).returning());
      const setFlags = (enrich: boolean, sugg: boolean) => {
        const set = { prospectEnrichmentEnabled: enrich, aiSuggestionsEnabled: sugg };
        return inE((tx) => tx.insert(s.organizationSettings).values({ tenantId: E, ...set }).onConflictDoUpdate({ target: s.organizationSettings.tenantId, set }));
      };

      // create action path sends the event (injectable sender), after commit
      const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
      const sendEvent = (async (name: string, data: Record<string, unknown>) => {
        sent.push({ name, data });
      }) as never;
      const cr = await asE(() => m.createProspect(E, eMember, { companyName: 'Enrich Me Pvt Ltd', city: 'Pune', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const pid = cr.ok ? cr.id : '';
      check('create action path sends event', cr.ok && sent.length === 1 && sent[0]!.name === 'crm/prospect.created' && sent[0]!.data.tenantId === E && sent[0]!.data.prospectId === pid, sent);

      const throwingSend = (async () => {
        throw new Error('inngest down');
      }) as never;
      const crThrow = await asE(() => m.createProspect(E, eMember, { companyName: 'Send Fails Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent: throwingSend }));
      check('create: a failing event send never fails the create', crThrow.ok, crThrow);

      // confirm-import sends one event per inserted prospect
      const [impRow] = await inE((tx) =>
        tx.insert(s.prospectImports).values({ tenantId: E, sourceTag: 'expo-e', inputKind: 'text', rawText: 'x', status: 'parsed', createdBy: eMember.userId }).returning(),
      );
      const batches: Array<{ name: string; data: Array<Record<string, unknown>> }> = [];
      const sendEvents = (async (name: string, data: Array<Record<string, unknown>>) => {
        batches.push({ name, data });
      }) as never;
      const ci = await asE(() =>
        imp.confirmImport(
          E,
          eMember,
          impRow!.id,
          [
            { companyName: 'Import One Co', clusterTags: [] },
            { companyName: 'Import Two Co', clusterTags: [] },
          ],
          { sendEvent, sendEvents },
        ),
      );
      const impIds = (await inE((tx) => tx.select({ id: s.prospects.id }).from(s.prospects).where(eq(s.prospects.importId, impRow!.id)))).map((r) => r.id).sort();
      const sentIds = (batches[0]?.data ?? []).map((d) => String(d.prospectId)).sort();
      check(
        'confirm-import sends one batch with one event per inserted prospect',
        ci.ok && batches.length === 1 && batches[0]!.name === 'crm/prospect.created' && batches[0]!.data.every((d) => d.tenantId === E) && impIds.length === 2 && JSON.stringify(sentIds) === JSON.stringify(impIds),
        { ci, impIds, batches },
      );

      // 250 rows -> the real batch sender makes 3 inngest.send calls (100 + 100 + 50)
      const { sendWorkflowEventsBatch } = await import('../src/lib/inngest/send');
      const inngestCalls: number[] = [];
      const realBatch = ((name: never, data: never) =>
        sendWorkflowEventsBatch(name, data, {
          send: async (events) => {
            inngestCalls.push(events.length);
          },
        })) as never;
      const [imp250] = await inE((tx) =>
        tx.insert(s.prospectImports).values({ tenantId: E, sourceTag: 'expo-250', inputKind: 'text', rawText: 'x', status: 'parsed', createdBy: eMember.userId }).returning(),
      );
      const c250 = await asE(() =>
        imp.confirmImport(E, eMember, imp250!.id, Array.from({ length: 250 }, (_, i) => ({ companyName: `Bulk Enrich Co ${i}`, clusterTags: [] })), { sendEvents: realBatch }),
      );
      check('confirm-import of 250 rows makes 3 batch sends', c250.ok && c250.inserted === 250 && JSON.stringify(inngestCalls) === JSON.stringify([100, 100, 50]), { c250, inngestCalls });

      const f = (value: unknown, reasoning: string, confidence = 0.8) => ({ value, reasoning, confidence });
      const answer = (o: Record<string, unknown> = {}) =>
        JSON.stringify({
          industry: f('Manufacturing', 'Pune-based manufacturer by name and city.'),
          size_band: f('51-200', 'Typical size for a Pvt Ltd manufacturer.'),
          product_fit: f(offE!.id, 'Payroll fits a mid-size workforce.'),
          icp_score: f(82, 'Good fit for Payroll Suite.'),
          ...o,
        });
      let calls = 0;
      let lastUser = '';
      const create = (body: string) =>
        (async (params: { messages: Array<{ content: unknown }> }) => {
          calls++;
          lastUser = JSON.stringify(params.messages[0]!.content);
          return {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: body, citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          };
        }) as never;
      const suggestionsFor = (id: string) => inE((tx) => tx.select().from(s.aiSuggestions).where(eq(s.aiSuggestions.entityId, id)));
      const prospectRow = async (id: string) => (await inE((tx) => tx.select().from(s.prospects).where(eq(s.prospects.id, id))))[0]!;

      // flags off -> skipped, no Claude call
      await setFlags(false, true);
      const off1 = await sysE(() => en.enrichProspect(E, pid, { create: create(answer()) }));
      await setFlags(true, false);
      const off2 = await sysE(() => en.enrichProspect(E, pid, { create: create(answer()) }));
      check('enrich: flags off → skipped', off1.status === 'skipped' && off2.status === 'skipped' && calls === 0 && (await suggestionsFor(pid)).length === 0, { off1, off2, calls });

      await setFlags(true, true);
      const before = await prospectRow(pid);
      const r1 = await sysE(() => en.enrichProspect(E, pid, { create: create(answer()) }));
      const sg = await suggestionsFor(pid);
      const byField = Object.fromEntries(sg.map((x) => [x.field, x]));
      check(
        'enrich: creates pending suggestions with entity prospect, source enrichment, evidence = reasoning',
        r1.status === 'done' &&
          r1.created === 4 &&
          sg.length === 4 &&
          sg.every((x) => x.entityType === 'prospect' && x.sourceType === 'enrichment' && x.sourceId === pid && x.status === 'pending' && x.currentValueAtSuggestion === null) &&
          byField.industry?.evidenceQuote === 'Pune-based manufacturer by name and city.' &&
          byField.icp_score?.suggestedValue === 82 &&
          byField.product_fit?.suggestedValue === offE!.id,
        { r1, sg: sg.map((x) => [x.field, x.entityType, x.sourceType, x.suggestedValue, x.evidenceQuote]) },
      );
      check('enrich: only active offerings are sent', lastUser.includes(offE!.id) && !lastUser.includes(offRetired!.id) && lastUser.includes('Enrich Me Pvt Ltd'));
      const [src] = await inE((tx) => tx.select().from(s.aiSuggestionSources).where(eq(s.aiSuggestionSources.sourceId, pid)));
      check('enrich: source marked done', src?.sourceType === 'enrichment' && src.status === 'done' && src.suggestionsCount === 4, src);

      const after = await prospectRow(pid);
      check(
        'enrich: never writes prospect fields',
        after.industry === null &&
          after.sizeBand === null &&
          after.productFitOfferingId === null &&
          after.icpScore === null &&
          after.updatedAt.getTime() === before.updatedAt.getTime() &&
          after.lastActivityAt.getTime() === before.lastActivityAt.getTime(),
        after,
      );

      const callsBefore = calls;
      const r2 = await sysE(() => en.enrichProspect(E, pid, { create: create(answer()) }));
      check('enrich: event twice → no duplicates', r2.status === 'skipped' && calls === callsBefore && (await suggestionsFor(pid)).length === 4, { r2 });

      // handler path (what the Inngest function runs)
      const wf = await import('../src/lib/inngest/workflows/prospects');
      const hp = await asE(() => m.createProspect(E, eMember, { companyName: 'Handler Path Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const step = { run: async <T,>(_id: string, fn: () => Promise<T>) => fn() };
      const hr = hp.ok ? await wf.prospectEnrichHandler({ event: { data: { tenantId: E, prospectId: hp.id } }, step } as never, { create: create(answer()) }) : null;
      check('enrich: handler runs enrichProspect in a system context', hr?.status === 'done' && (await suggestionsFor(hp.ok ? hp.id : E)).length === 4, hr);

      // Retries: a step stub that re-runs its callback when it throws (like Inngest retrying a step).
      let stepAttempts = 0;
      const retryingStep = {
        run: async <T,>(_id: string, fn: () => Promise<T>): Promise<T> => {
          for (let attempt = 1; ; attempt++) {
            stepAttempts++;
            try {
              return await fn();
            } catch (err) {
              if (attempt >= 3) throw err;
            }
          }
        },
      };
      const ht = await asE(() => m.createProspect(E, eMember, { companyName: 'Transient Error Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      let flaky = 0;
      const flakyCreate = (async (params: never) => {
        flaky++;
        if (flaky === 1) throw new Error('stream dropped'); // non-API error -> retryable
        return (create(answer()) as unknown as (p: never) => Promise<unknown>)(params);
      }) as never;
      const htr = ht.ok ? await wf.prospectEnrichHandler({ event: { data: { tenantId: E, prospectId: ht.id } }, step: retryingStep } as never, { create: flakyCreate }) : null;
      check(
        'enrich: retryable failure throws inside the step, so the retry re-runs the Claude call',
        htr?.status === 'done' && stepAttempts === 2 && flaky === 2 && (await suggestionsFor(ht.ok ? ht.id : E)).length === 4,
        { htr, stepAttempts, flaky },
      );

      stepAttempts = 0;
      const hn = await asE(() => m.createProspect(E, eMember, { companyName: 'Refused In Step Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const refusingInStep = (async () => ({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: 'refusal',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as never;
      const hnr = hn.ok ? await wf.prospectEnrichHandler({ event: { data: { tenantId: E, prospectId: hn.id } }, step: retryingStep } as never, { create: refusingInStep }) : null;
      check(
        'enrich: non-retryable failure returns normally (no step retry, no throw)',
        hnr?.status === 'failed' && hnr.retryable === false && stepAttempts === 1,
        { hnr, stepAttempts },
      );

      // promoted / deleted before the job runs -> skipped, no suggestions
      const pp = await asE(() => m.createProspect(E, eMember, { companyName: 'Promoted Early Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const [dl] = await inE((tx) => tx.insert(s.deals).values({ tenantId: E, name: 'Already a lead' }).returning());
      if (pp.ok) await inE((tx) => tx.update(s.prospects).set({ promotedDealId: dl!.id, promotedAt: new Date() }).where(eq(s.prospects.id, pp.id)));
      const rp = pp.ok ? await sysE(() => en.enrichProspect(E, pp.id, { create: create(answer()) })) : null;
      check('enrich: promoted prospect → skipped', rp?.status === 'skipped' && (await suggestionsFor(pp.ok ? pp.id : E)).length === 0, rp);

      const pd = await asE(() => m.createProspect(E, eMember, { companyName: 'Deleted Early Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      if (pd.ok) await inE((tx) => tx.update(s.prospects).set({ deletedAt: new Date() }).where(eq(s.prospects.id, pd.id)));
      const rd = pd.ok ? await sysE(() => en.enrichProspect(E, pd.id, { create: create(answer()) })) : null;
      check('enrich: deleted prospect → skipped', rd?.status === 'skipped' && (await suggestionsFor(pd.ok ? pd.id : E)).length === 0, rd);

      // invented (retired) offering / bad ICP / bad size band dropped; an existing value is not suggested
      const pv = await asE(() =>
        m.createProspect(E, eMember, { companyName: 'Validated Co', industry: 'Textiles', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }),
      );
      const rv = pv.ok
        ? await sysE(() =>
            en.enrichProspect(E, pv.id, {
              create: create(answer({ product_fit: f(offRetired!.id, 'retired one'), icp_score: f(140, 'too high'), size_band: f('50-100', 'not a band') })),
            }),
          )
        : null;
      const sv = await suggestionsFor(pv.ok ? pv.id : E);
      check('enrich: invalid values dropped and existing industry not suggested', rv?.status === 'done' && sv.length === 0 && rv.dropped >= 3, { rv, sv: sv.map((x) => x.field) });

      // refusal -> failed, nothing persisted, a later delivery can retry
      const pr = await asE(() => m.createProspect(E, eMember, { companyName: 'Refused Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const refusing = (async () => ({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: 'refusal',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })) as never;
      const rr = pr.ok ? await sysE(() => en.enrichProspect(E, pr.id, { create: refusing })) : null;
      const rr0 = pr.ok ? (await suggestionsFor(pr.id)).length : -1;
      const rr2 = pr.ok ? await sysE(() => en.enrichProspect(E, pr.id, { create: create(answer()) })) : null;
      check(
        'enrich: refusal → failed, no suggestions; a later delivery can retry',
        rr?.status === 'failed' && rr0 === 0 && rr2?.status === 'done' && (await suggestionsFor(pr.ok ? pr.id : E)).length === 4,
        { rr, rr0, rr2 },
      );

      // no API key and no injected client -> skipped
      const keySaved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const pk = await asE(() => m.createProspect(E, eMember, { companyName: 'No Key Co', sourceTag: 'selftest', clusterTags: [] } as never, { sendEvent }));
      const rk = pk.ok ? await sysE(() => en.enrichProspect(E, pk.id)) : null;
      if (keySaved !== undefined) process.env.ANTHROPIC_API_KEY = keySaved;
      check('enrich: no ANTHROPIC_API_KEY → skipped', rk?.status === 'skipped', rk);
    }
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B}, ${C}, ${D}, ${E})`);
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
