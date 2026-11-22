import { config } from 'dotenv';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold a real key: this test must never reach Claude.
process.env.ANTHROPIC_API_KEY = '';

/**
 * DB-backed self-test for lead capture (build prompt 1). Runs against
 * DATABASE_URL with migration 0072 applied. Creates two throwaway tenants and
 * deletes them (cascade) at the end.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-lead-capture-db.ts
 *
 * Covers the prompt's verification checklist where a database is needed:
 * signed ingest → lead → assignment; bad signature creates nothing; replay ×5
 * = 1 lead; phone-format dedupe; cross-source re-enquiry; 200-lead
 * round-robin concurrency; off-hours queueing; SLA reassign → escalate;
 * touched leads never reassigned; simulate = real; tenant isolation.
 */
let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, runWithTenantContext, tenantTransaction } = await import('../src/lib/db-context');
  const { receiveIngestEvent, processIngestEvent, lookupSourceForPublic } = await import('../src/lib/lead-capture/ingest');
  const { distributeLead, simulateDistribution } = await import('../src/lib/lead-capture/distribute');
  const { runSlaWatchdog } = await import('../src/lib/lead-capture/sla');
  const { generateSourceSecret, signBody, verifyIngestAuth } = await import('../src/lib/lead-capture/signature');
  const { recordActivity } = await import('../src/lib/activity/recorder');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Lead Capture A', ${`zz-lc-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Lead Capture B', ${`zz-lc-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_lctest_${stamp}_${n}`;
  const [u1, u2, u3, u4, mgr] = [U('u1'), U('u2'), U('u3'), U('u4'), U('mgr')];

  const asA = <T>(fn: () => Promise<T>) => runWithSystemContext(A, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithSystemContext(B, fn);

  try {
    // ------------------------------------------------------------ fixtures
    const secret = generateSourceSecret();
    const { webSrc, portalSrc, offSrc, rrRule } = await asA(() =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values([
          { tenantId: A, userId: u1, role: 'member' },
          { tenantId: A, userId: u2, role: 'member' },
          { tenantId: A, userId: u3, role: 'member' },
          { tenantId: A, userId: u4, role: 'member' },
          { tenantId: A, userId: mgr, role: 'manager' },
        ]);
        // u4 only works on a day that is never today, so any rule that only has
        // u4 must queue for that shift. (UTC day + 2 is never today in IST, which
        // is at most one day ahead of UTC.) A rep with no working days at all has
        // no next shift and correctly goes to the unassigned queue instead.
        const offDay = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[(new Date().getUTCDay() + 2) % 7]!;
        await tx.insert(s.userRoutingProfile).values({ tenantId: A, userId: u4, workingHours: { tz: 'Asia/Kolkata', days: { [offDay]: ['09:00', '18:00'] } } });
        const [w] = await tx.insert(s.leadSources).values({ tenantId: A, name: 'Website', type: 'webhook', secretToken: secret }).returning();
        const [p] = await tx.insert(s.leadSources).values({ tenantId: A, name: 'IndiaMART', type: 'portal', secretToken: generateSourceSecret() }).returning();
        const [o] = await tx.insert(s.leadSources).values({ tenantId: A, name: 'Night form', type: 'web_form', secretToken: generateSourceSecret() }).returning();
        const [rr] = await tx
          .insert(s.distributionRules)
          .values({ tenantId: A, name: 'Default RR', priority: 100, strategy: 'round_robin', pool: { user_ids: [u1, u2, u3] }, isDefault: true, slaMinutes: 30, maxReassignments: 1, respectAvailability: true })
          .returning();
        await tx.insert(s.distributionRules).values({
          tenantId: A,
          name: 'Night shift only',
          priority: 10,
          strategy: 'round_robin',
          conditions: [{ field: 'source_id', op: 'eq', value: o!.id }],
          pool: { user_ids: [u4] },
        });
        return { webSrc: w!, portalSrc: p!, offSrc: o!, rrRule: rr! };
      }),
    );
    await asB(() =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values({ tenantId: B, userId: U('b1'), role: 'member' });
      }),
    );

    const ingest = async (sourceId: string, payload: unknown) => {
      const r = await receiveIngestEvent({ tenantId: A, sourceId, payload });
      const out = await asA(() => processIngestEvent(r.eventId));
      return { ...r, out };
    };
    const dealCountForPhone = (phone: string) =>
      asA(() =>
        tenantTransaction(async (tx) => {
          const rows = await tx
            .select({ id: s.deals.id })
            .from(s.deals)
            .innerJoin(s.contacts, eq(s.contacts.id, s.deals.contactId))
            .where(and(eq(s.deals.tenantId, A), eq(s.contacts.phoneNormalized, phone)));
          return rows.length;
        }),
      );

    // ------------------------------------------------------------ signed ingest → lead → assigned
    const payload = { name: 'Ravi Kumar', mobile: '+91 98111 22233', email: 'ravi@acme.test', company: 'Acme Castings', city: 'Pune' };
    const body = JSON.stringify(payload);
    check('public lookup resolves source tenant', (await lookupSourceForPublic(webSrc.id))?.tenantId === A);
    check('signed body verifies', verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: `sha256=${signBody(body, secret)}` }));
    check('bad signature rejected', !verifyIngestAuth({ rawBody: body, secret, tokenHeader: null, signatureHeader: `sha256=${signBody(body, 'wrong')}` }));

    const first = await ingest(webSrc.id, payload);
    check('ingest creates a lead', first.out.status === 'created', first.out);
    const leadId = first.out.status === 'created' ? first.out.dealId : '';
    const assigned = await asA(() => distributeLead({ tenantId: A, dealId: leadId }));
    check('lead assigned by round robin to u1', assigned.status === 'assigned' && assigned.userId === u1, assigned);
    const dealRow = await asA(() => tenantTransaction((tx) => tx.select().from(s.deals).where(eq(s.deals.id, leadId))));
    check('deal owner + routing status set', dealRow[0]?.ownerId === u1 && dealRow[0]?.routingStatus === 'assigned');
    const again = await asA(() => distributeLead({ tenantId: A, dealId: leadId }));
    check('second distribute is a no-op', again.status === 'skipped', again);

    // ------------------------------------------------------------ replay ×5
    const replays = [];
    for (let i = 0; i < 5; i++) replays.push(await ingest(webSrc.id, { ...payload }));
    check('replays return the original event', replays.every((r) => r.replay && r.eventId === first.eventId));
    check('replays are no-ops', replays.every((r) => r.out.status === 'noop'));
    check('replay ×5 = 1 lead', (await dealCountForPhone('+919811122233')) === 1);

    // ------------------------------------------------------------ phone formats dedupe
    const fmts = ['+91 98111 22233', '098111 22233', '9811122233'];
    const fmtOut = [];
    for (const [i, mobile] of fmts.entries()) fmtOut.push((await ingest(webSrc.id, { name: 'Ravi', mobile, note: `variant ${i}` })).out.status);
    check('all phone formats take the duplicate path', fmtOut.every((st) => st === 'duplicate'), fmtOut);
    check('phone formats still 1 lead', (await dealCountForPhone('+919811122233')) === 1);

    // ------------------------------------------------------------ cross-source re-enquiry
    const cross = await ingest(portalSrc.id, { SENDER_NAME: 'Ravi', SENDER_MOBILE: '9811122233', QUERY_PRODUCT_NAME: 'Furnace' });
    check('second source → duplicate, same lead', cross.out.status === 'duplicate' && cross.out.dealId === leadId, cross.out);
    const notes = await asA(() =>
      tenantTransaction((tx) =>
        tx.select({ m: s.activityLogs.metadata }).from(s.activityLogs).where(and(eq(s.activityLogs.entityId, leadId), eq(s.activityLogs.action, 'automation_note'))),
      ),
    );
    check('re-enquiry activity names the new source', notes.some((n) => String((n.m as { message?: string }).message).includes('Re-enquiry via IndiaMART')));

    // ------------------------------------------------------------ mapping failure is stored, not lost
    const bad = await ingest(webSrc.id, { name: 'No contact details' });
    check('lead without phone/email fails with reason', bad.out.status === 'failed' && bad.out.error === 'need at least a phone or an email', bad.out);

    // ------------------------------------------------------------ off-hours → queued
    const night = await ingest(offSrc.id, { name: 'Night Owl', email: `owl-${stamp}@night.test` });
    const nightId = night.out.status === 'created' ? night.out.dealId : '';
    const nightOut = await asA(() => distributeLead({ tenantId: A, dealId: nightId }));
    const nightDeal = await asA(() => tenantTransaction((tx) => tx.select().from(s.deals).where(eq(s.deals.id, nightId))));
    check('off-hours lead is queued, not assigned', nightOut.status === 'queued' && nightDeal[0]?.ownerId === null && nightDeal[0]?.routingStatus === 'unassigned', nightOut);

    // ------------------------------------------------------------ simulate = real
    const sim = await asA(() => simulateDistribution({ tenantId: A, sample: { sourceId: webSrc.id, city: 'Nagpur' } }));
    const simLead = await ingest(webSrc.id, { name: 'Sim Lead', email: `sim-${stamp}@x.test`, city: 'Nagpur' });
    const simId = simLead.out.status === 'created' ? simLead.out.dealId : '';
    const real = await asA(() => distributeLead({ tenantId: A, dealId: simId }));
    check('simulate predicts the real assignment', sim.kind === 'assign' && real.status === 'assigned' && sim.userId === real.userId, { sim: sim.kind === 'assign' ? sim.userId : sim.kind, real });

    // ------------------------------------------------------------ SLA: reassign once, then escalate
    const backdate = (dealId: string) =>
      asA(() =>
        tenantTransaction((tx) =>
          tx.update(s.leadAssignments).set({ slaDueAt: new Date(Date.now() - 60_000) }).where(and(eq(s.leadAssignments.dealId, dealId), isNull(s.leadAssignments.releasedAt))),
        ),
      );
    const firstOwner = real.status === 'assigned' ? real.userId : '';
    await backdate(simId);
    const w1 = await asA(() => runSlaWatchdog(A));
    const afterW1 = await asA(() =>
      tenantTransaction((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, simId)).orderBy(s.leadAssignments.assignedAt)),
    );
    const open1 = afterW1.find((a) => !a.releasedAt);
    check('watchdog reassigned once', w1.reassigned >= 1 && afterW1.length === 2, { w1, n: afterW1.length });
    check('reassignment excludes previous owner', !!open1 && open1.assignedTo !== firstOwner, { firstOwner, now: open1?.assignedTo });
    check('released row says sla_breach', afterW1[0]?.releaseReason === 'sla_breach');
    await backdate(simId);
    const w2 = await asA(() => runSlaWatchdog(A));
    const afterW2 = await asA(() => tenantTransaction((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, simId))));
    check('stops at max_reassignments and escalates', afterW2.length === 2 && w2.escalated >= 1 && afterW2.some((a) => !a.releasedAt && a.escalatedAt), w2);
    // Read as the manager, like the bell does: notifications are only visible
    // to their recipient, so a system-context read would always see none.
    const mgrNotes = await runWithTenantContext({ tenantId: A, userId: mgr }, () =>
      tenantTransaction((tx) =>
        tx.select({ id: s.notifications.id }).from(s.notifications).where(and(eq(s.notifications.recipientUserId, mgr), eq(s.notifications.type, 'lead_sla_breach'))),
      ),
    );
    check('manager notified of the escalation', mgrNotes.length >= 1);

    // ------------------------------------------------------------ touched lead is never reassigned
    const touchedOwner = assigned.status === 'assigned' ? assigned.userId : '';
    await runWithTenantContext({ tenantId: A, userId: touchedOwner }, () =>
      recordActivity(db, { tenantId: A, actorUserId: touchedOwner, entityType: 'deal', entityId: leadId, action: 'call_logged', metadata: { name: 'x' } }),
    );
    const touched = await asA(() =>
      tenantTransaction((tx) => tx.select().from(s.leadAssignments).where(and(eq(s.leadAssignments.dealId, leadId), isNull(s.leadAssignments.releasedAt)))),
    );
    check('owner call sets first_touch_at', !!touched[0]?.firstTouchAt);
    await backdate(leadId);
    await asA(() => runSlaWatchdog(A));
    const stillOwner = await asA(() => tenantTransaction((tx) => tx.select({ o: s.deals.ownerId }).from(s.deals).where(eq(s.deals.id, leadId))));
    check('touched lead keeps its owner after SLA', stillOwner[0]?.o === touchedOwner);

    // ------------------------------------------------------------ 200 concurrent leads, 3-user round robin
    const concIds = await asA(() =>
      tenantTransaction(async (tx) => {
        const rows = await tx
          .insert(s.deals)
          .values(Array.from({ length: 200 }, (_, i) => ({ tenantId: A, name: `conc ${i}`, stage: 'lead' as const, currency: 'INR', routingStatus: 'pending' as const })))
          .returning({ id: s.deals.id });
        return rows.map((r) => r.id);
      }),
    );
    const t0 = Date.now();
    const outs = await Promise.all(concIds.map((id) => asA(() => distributeLead({ tenantId: A, dealId: id }))));
    const counts: Record<string, number> = {};
    for (const o of outs) if (o.status === 'assigned') counts[o.userId] = (counts[o.userId] ?? 0) + 1;
    const vals = [u1, u2, u3].map((u) => counts[u] ?? 0);
    check('200 concurrent leads all assigned', outs.every((o) => o.status === 'assigned'), outs.filter((o) => o.status !== 'assigned').slice(0, 3));
    check('round robin balanced within 1', Math.max(...vals) - Math.min(...vals) <= 1, { counts, ms: Date.now() - t0 });
    const openPer = await asA(() =>
      tenantTransaction((tx) =>
        tx
          .select({ dealId: s.leadAssignments.dealId, n: sql<number>`count(*)::int` })
          .from(s.leadAssignments)
          .where(and(inArray(s.leadAssignments.dealId, concIds), isNull(s.leadAssignments.releasedAt)))
          .groupBy(s.leadAssignments.dealId),
      ),
    );
    check('no lead double-assigned', openPer.length === 200 && openPer.every((r) => Number(r.n) === 1), { rows: openPer.length });

    // ------------------------------------------------------------ tenant isolation (negative)
    const seenFromB = await asB(() =>
      tenantTransaction(async (tx) => ({
        deals: (await tx.select({ id: s.deals.id }).from(s.deals).where(eq(s.deals.id, leadId))).length,
        sources: (await tx.select({ id: s.leadSources.id }).from(s.leadSources).where(eq(s.leadSources.tenantId, A))).length,
        rules: (await tx.select({ id: s.distributionRules.id }).from(s.distributionRules).where(eq(s.distributionRules.tenantId, A))).length,
        assignments: (await tx.select({ id: s.leadAssignments.id }).from(s.leadAssignments).where(eq(s.leadAssignments.dealId, leadId))).length,
        events: (await tx.select({ id: s.leadIngestEvents.id }).from(s.leadIngestEvents).where(eq(s.leadIngestEvents.tenantId, A))).length,
        ruleUpdate: (await tx.update(s.distributionRules).set({ name: 'hijacked' }).where(eq(s.distributionRules.id, rrRule.id)).returning({ id: s.distributionRules.id })).length,
      })),
    );
    check('tenant B sees none of A’s leads, sources, rules, assignments, events', Object.values(seenFromB).every((n) => n === 0), seenFromB);
    const crossAssign = await asB(() => distributeLead({ tenantId: B, dealId: leadId }));
    check('tenant B cannot assign A’s lead', crossAssign.status === 'skipped', crossAssign);
    const crossSim = await asB(() => simulateDistribution({ tenantId: B, sample: { sourceId: webSrc.id } }));
    check('tenant B simulate finds no rule', crossSim.kind === 'unassigned' && crossSim.rule === null, crossSim.kind);
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  console.log('\n─── Lead capture DB self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
