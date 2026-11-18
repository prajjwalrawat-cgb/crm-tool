import { config } from 'dotenv';
import { and, eq, inArray, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for telephony (build prompt 2). Needs migrations 0072 +
 * 0073 applied. Creates two throwaway tenants and deletes them at the end.
 * Uses the mock provider (TELEPHONY_ALLOW_MOCK=true) and a throwaway KMS key.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-telephony-db.ts
 */
process.env.TELEPHONY_ALLOW_MOCK = 'true';
process.env.KMS_KEY = process.env.KMS_KEY || 'c'.repeat(64);

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  if (!ok) exitCode = 1;
}

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, runWithTenantContext, tenantTransaction } = await import('../src/lib/db-context');
  const { encryptJson, generateWebhookSecret } = await import('../src/lib/telephony/crypto');
  const { clickToCall, processCallEvent, saveDisposition, getCallScoped } = await import('../src/lib/telephony/service');
  const { createCampaign, claimNextItem, setCampaignStatus } = await import('../src/lib/telephony/campaigns');
  const { mockCalls } = await import('../src/lib/telephony/providers/mock');
  const { mockProvider } = await import('../src/lib/telephony/providers/mock');
  const { serializeCall } = await import('../src/lib/telephony/serialize');

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Tel A', ${`zz-tel-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ Tel B', ${`zz-tel-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_teltest_${stamp}_${n}`;
  const [rep1, rep2, rep3, mgr] = [U('r1'), U('r2'), U('r3'), U('mgr')];
  const asA = <T>(fn: () => Promise<T>) => runWithSystemContext(A, fn);
  const ev = (o: Record<string, unknown>) => mockProvider.parseWebhook(o)!;

  try {
    const { accountId, dealId } = await asA(() =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values([
          { tenantId: A, userId: rep1, role: 'member' },
          { tenantId: A, userId: rep2, role: 'member' },
          { tenantId: A, userId: rep3, role: 'member' },
          { tenantId: A, userId: mgr, role: 'manager' },
        ]);
        // Calling hours wide open so the test runs any time of day.
        await tx.insert(s.telephonySettings).values({ tenantId: A, callingHours: { tz: 'UTC', start: '00:00', end: '24:00' } });
        const [acc] = await tx
          .insert(s.telephonyAccounts)
          .values({ tenantId: A, provider: 'mock', credentialsEncrypted: encryptJson({}), virtualNumbers: ['+918047180000'], webhookSecret: generateWebhookSecret() })
          .returning();
        await tx.insert(s.userPhoneMapping).values([
          { tenantId: A, userId: rep1, agentPhone: '+919800000001' },
          { tenantId: A, userId: rep2, agentPhone: '+919800000002' },
          { tenantId: A, userId: rep3, agentPhone: '+919800000003' },
        ]);
        const [c] = await tx.insert(s.contacts).values({ tenantId: A, firstName: 'Ravi', phone: '+91 98111 22233', phoneNormalized: '+919811122233' }).returning();
        const [d] = await tx.insert(s.deals).values({ tenantId: A, name: 'Acme lead', stage: 'lead', currency: 'INR', contactId: c!.id, ownerId: rep1 }).returning();
        await tx.insert(s.leadAssignments).values({ tenantId: A, dealId: d!.id, assignedTo: rep1, assignedBy: 'test', slaDueAt: new Date(Date.now() + 3600_000) });
        return { accountId: acc!.id, dealId: d!.id };
      }),
    );

    // ---------------------------------------------- click-to-call creates the row first
    const { callId } = await runWithTenantContext({ tenantId: A, userId: rep1 }, () => clickToCall({ tenantId: A, userId: rep1, role: 'member', leadId: dealId }));
    const mock = mockCalls.find((m) => m.customData === callId)!;
    const row0 = await asA(() => tenantTransaction(async (tx) => (await tx.select().from(s.calls).where(eq(s.calls.id, callId)))[0]));
    check('calls row exists before any webhook', !!row0 && row0.status === 'initiated' && row0.providerCallId === mock.providerCallId);

    // ---------------------------------------------- out-of-order + duplicate webhooks
    const pid = mock.providerCallId;
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: pid, status: 'completed', talkTimeSec: 95, recordingUrl: 'https://mock/rec.mp3' }) }));
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: pid, status: 'answered' }) }));
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: pid, status: 'completed', talkTimeSec: 95 }) }));
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: pid, status: 'ringing' }) }));
    const rows = await asA(() => tenantTransaction((tx) => tx.select().from(s.calls).where(and(eq(s.calls.tenantId, A), eq(s.calls.providerCallId, pid)))));
    check('exactly one row after duplicate/out-of-order webhooks', rows.length === 1, rows.length);
    check('final status completed, talk time kept', rows[0]?.status === 'completed' && rows[0]?.talkTimeSec === 95, rows[0]?.status);
    const acts = await asA(() =>
      tenantTransaction((tx) => tx.select().from(s.activityLogs).where(and(eq(s.activityLogs.entityId, dealId), eq(s.activityLogs.action, 'call_logged')))),
    );
    check('one call_logged timeline entry', acts.length === 1, acts.length);
    const [asg] = await asA(() => tenantTransaction((tx) => tx.select().from(s.leadAssignments).where(eq(s.leadAssignments.dealId, dealId))));
    check('first_touch_at set by the outbound call', !!asg?.firstTouchAt);

    // ---------------------------------------------- serialization + recording access
    check('API shape omits provider URL', !JSON.stringify(serializeCall(rows[0]!)).includes('mock/rec.mp3'));
    await asA(() => tenantTransaction((tx) => tx.update(s.calls).set({ recordingStorageKey: 'tenant/x/calls/y.mp3' }).where(eq(s.calls.id, callId))));
    const own = await runWithTenantContext({ tenantId: A, userId: rep1 }, () => getCallScoped(A, { userId: rep1, role: 'member' }, callId));
    const other = await runWithTenantContext({ tenantId: A, userId: rep2 }, () => getCallScoped(A, { userId: rep2, role: 'member' }, callId));
    const manager = await runWithTenantContext({ tenantId: A, userId: mgr }, () => getCallScoped(A, { userId: mgr, role: 'manager' }, callId));
    const crossTenant = await runWithTenantContext({ tenantId: B, userId: rep1 }, () => getCallScoped(B, { userId: rep1, role: 'owner' }, callId));
    check('rep sees own call', !!own);
    check('other rep denied', other === null);
    check('manager sees team call', !!manager);
    check('other tenant denied', crossTenant === null);

    // ---------------------------------------------- inbound known number: popup latency
    const t0 = Date.now();
    const known = await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: `in-${stamp}`, status: 'ringing', direction: 'inbound', from: '09811122233', to: '+918047180000' }) }));
    const ms = Date.now() - t0;
    const knownRow = await asA(() => tenantTransaction(async (tx) => (await tx.select().from(s.calls).where(eq(s.calls.id, known.callId)))[0]));
    check('inbound known number matched to the lead + owner', knownRow?.leadId === dealId && knownRow?.userId === rep1, knownRow);
    check(`inbound popup published within 2s (${ms} ms)`, known.inboundRinging && ms < 2000, { ms });

    // ---------------------------------------------- unknown inbound: stub lead, distributed, missed task
    await asA(() =>
      tenantTransaction((tx) =>
        tx.insert(s.distributionRules).values({ tenantId: A, name: 'Default', priority: 100, strategy: 'round_robin', pool: { user_ids: [rep2] }, isDefault: true }),
      ),
    );
    const unknown = await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: `in2-${stamp}`, status: 'ringing', direction: 'inbound', from: '+919700000099', to: '+918047180000' }) }));
    const stub = await asA(() => tenantTransaction(async (tx) => (await tx.select().from(s.deals).where(eq(s.deals.id, unknown.stubLeadId ?? '00000000-0000-0000-0000-000000000000')))[0]));
    check('unknown inbound creates a stub lead', !!stub && stub.source === 'Inbound call');
    check('stub lead distributed', stub?.ownerId === rep2, stub?.ownerId);
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: `in2-${stamp}`, status: 'missed', direction: 'inbound' }) }));
    const missedTasks = await asA(() =>
      tenantTransaction((tx) => tx.select().from(s.tasks).where(and(eq(s.tasks.tenantId, A), eq(s.tasks.entityId, unknown.stubLeadId!)))),
    );
    check('missed inbound creates a callback task', missedTasks.length === 1 && missedTasks[0]!.title.includes('missed call'));

    // ---------------------------------------------- disposition: DNC blocks future calls
    const disp = await runWithTenantContext({ tenantId: A, userId: rep1 }, () =>
      saveDisposition({ tenantId: A, userId: rep1, role: 'member', callId, disposition: 'do_not_call', notes: null, callbackAt: null }),
    );
    check('do_not_call disposition saved', disp.ok);
    let blocked = false;
    try {
      await runWithTenantContext({ tenantId: A, userId: rep1 }, () => clickToCall({ tenantId: A, userId: rep1, role: 'member', leadId: dealId }));
    } catch (e) {
      blocked = (e as { code?: string }).code === 'dnc';
    }
    check('DNC number blocks click-to-call', blocked);
    const skipLong = await runWithTenantContext({ tenantId: A, userId: rep1 }, () =>
      saveDisposition({ tenantId: A, userId: rep1, role: 'member', callId, disposition: 'skipped', notes: null, callbackAt: null }),
    );
    check('skip refused for a 95s connected call', !skipLong.ok);

    // ---------------------------------------------- dialer: 50 items, 3 agents, SKIP LOCKED
    const leadIds = await asA(() =>
      tenantTransaction(async (tx) => {
        const cs = await tx
          .insert(s.contacts)
          .values(Array.from({ length: 50 }, (_, i) => ({ tenantId: A, phone: `+9197${String(10000000 + i)}`, phoneNormalized: `+9197${String(10000000 + i)}` })))
          .returning({ id: s.contacts.id });
        const ds = await tx
          .insert(s.deals)
          .values(cs.map((c, i) => ({ tenantId: A, name: `dial ${i}`, stage: 'qualified' as const, currency: 'INR', contactId: c.id })))
          .returning({ id: s.deals.id });
        return ds.map((d) => d.id);
      }),
    );
    const campaign = await asA(() =>
      createCampaign({
        tenantId: A,
        userId: mgr,
        input: { name: 'test', mode: 'preview', leadFilter: { dealIds: leadIds }, agentIds: [rep1, rep2, rep3], callingHours: { tz: 'UTC', start: '00:00', end: '24:00' }, maxAttempts: 2, retryGapMinutes: 120 },
      }),
    );
    await asA(() => setCampaignStatus(A, campaign.id, 'running'));
    const claims = await Promise.all(
      Array.from({ length: 30 }, (_, i) => [rep1, rep2, rep3][i % 3]!).map((agent) =>
        asA(async () => {
          // Each agent releases (skips) and claims again, to churn the queue concurrently.
          const n = await claimNextItem({ tenantId: A, campaignId: campaign.id, agentUserId: agent });
          return { agent, itemId: n?.item.id ?? null };
        }),
      ),
    );
    const held = await asA(() =>
      tenantTransaction((tx) =>
        tx.select().from(s.callCampaignItems).where(and(eq(s.callCampaignItems.campaignId, campaign.id), eq(s.callCampaignItems.state, 'locked'))),
      ),
    );
    const byAgent = new Map<string, number>();
    for (const h of held) byAgent.set(h.lockedBy!, (byAgent.get(h.lockedBy!) ?? 0) + 1);
    check('each agent holds at most one item; no item locked twice', held.length === 3 && [...byAgent.values()].every((v) => v === 1), { held: held.length, byAgent: [...byAgent] });
    const claimedIds = new Map<string, Set<string>>();
    for (const c of claims) if (c.itemId) (claimedIds.get(c.itemId) ?? claimedIds.set(c.itemId, new Set()).get(c.itemId)!).add(c.agent);
    check('no item claimed by two agents', [...claimedIds.values()].every((agents) => agents.size === 1));

    // Retry gap: a no-answer call re-queues with next_attempt_at ≈ now + 120 min.
    const item = held.find((h) => h.lockedBy === rep1)!;
    await asA(() => tenantTransaction((tx) => tx.update(s.callCampaignItems).set({ attempts: 1 }).where(eq(s.callCampaignItems.id, item.id))));
    const [fakeCall] = await asA(() =>
      tenantTransaction((tx) =>
        tx
          .insert(s.calls)
          .values({ tenantId: A, accountId, provider: 'mock', providerCallId: `dial-${stamp}`, direction: 'outbound', leadId: item.leadId, userId: rep1, fromNumber: 'x', toNumber: 'y', status: 'ringing', campaignId: campaign.id, campaignItemId: item.id })
          .returning(),
      ),
    );
    await asA(() => processCallEvent({ tenantId: A, accountId, provider: 'mock', event: ev({ callId: fakeCall!.providerCallId, status: 'no_answer' }) }));
    const [requeued] = await asA(() => tenantTransaction((tx) => tx.select().from(s.callCampaignItems).where(eq(s.callCampaignItems.id, item.id))));
    const gapMin = requeued?.nextAttemptAt ? (requeued.nextAttemptAt.getTime() - Date.now()) / 60000 : 0;
    check('no-answer re-queued honouring the retry gap', requeued?.state === 'pending' && gapMin > 115 && gapMin <= 121, { state: requeued?.state, gapMin });

    // DNC mid-campaign cancels the item.
    const target = held.find((h) => h.lockedBy === rep2)!;
    const [tc] = await asA(() =>
      tenantTransaction((tx) => tx.execute<{ p: string }>(sql`select c.phone as p from deals d join contacts c on c.id = d.contact_id where d.id = ${target.leadId}`)),
    );
    const { addDnc } = await import('../src/lib/telephony/accounts');
    await asA(() => tenantTransaction((tx) => addDnc(tx, { tenantId: A, phone: tc!.p, reason: 'test', addedBy: mgr })));
    const [cancelled] = await asA(() => tenantTransaction((tx) => tx.select().from(s.callCampaignItems).where(eq(s.callCampaignItems.id, target.id))));
    check('DNC mid-campaign cancels the item', cancelled?.state === 'skipped' && cancelled?.skipReason === 'dnc', cancelled?.state);

    // Tenant isolation on the dialer queue.
    const seenFromB = await runWithSystemContext(B, () =>
      tenantTransaction(async (tx) => (await tx.select().from(s.callCampaignItems).where(inArray(s.callCampaignItems.leadId, leadIds))).length),
    );
    check('tenant B sees none of A’s campaign items', seenFromB === 0);
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  console.log('\n─── Telephony DB self-test ───');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  (${r.detail})` : ''}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
