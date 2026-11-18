import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for AI suggestions (0077). Two throwaway tenants,
 * deleted at the end. Claude is mocked (injected `create`); the extractor's
 * real validation runs. Appliers are injected because the real ones are
 * session-bound server actions; the stage applier uses the real stage-gate
 * engine (evaluateStageTransition), so gate enforcement on accept is real.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-ai-suggestions-db.ts
 */

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
  const svc = await import('../src/lib/ai/suggestions/service');
  const { extractSuggestions } = await import('../src/lib/ai/suggestions/extract');
  const { evaluateStageTransition } = await import('../src/lib/stage-gates/evaluate');
  const { blockMessage } = await import('../src/lib/stage-gates/enforce');
  const { toMinorUnits } = await import('../src/lib/deals/currency');
  const { suggestionsFromCallHandler } = await import('../src/lib/inngest/workflows/ai-suggestions');
  type Appliers = import('../src/lib/ai/suggestions/service').Appliers;

  const step = { run: <T,>(_id: string, fn: () => Promise<T>) => fn(), sleep: async () => {} };
  const TRANSCRIPT = [
    'Agent: Sir, when are you planning to finalise?',
    "Customer: Let's close this by 15 December, budget is around 12 lakh.",
    'Agent: Perfect, I will send the revised proposal.',
  ].join('\n');

  // Mock Claude: proposes close_date + amount (+ one invalid item that validation must drop).
  let claudeCalls = 0;
  const mockCreate = (items: unknown[]) =>
    (async () => {
      claudeCalls++;
      return {
        id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 150 },
        content: [{ type: 'tool_use', id: 'tu', name: 'propose_field_changes', input: { suggestions: items } }],
      } as unknown as import('@anthropic-ai/sdk').default.Message;
    }) as never;
  const demoItems = [
    { target: 'deal', field: 'close_date', value: '2026-12-15', due_date: null, evidence_quote: "Let's close this by 15 December", confidence: 0.9 },
    { target: 'deal', field: 'amount', value: '1200000', due_date: null, evidence_quote: 'budget is around 12 lakh', confidence: 0.75 },
    { target: 'deal', field: 'stage', value: 'closed', due_date: null, evidence_quote: 'finalise', confidence: 0.5 },
  ];
  const deps = (items: unknown[]) => ({ extract: (input: Parameters<typeof extractSuggestions>[0]) => extractSuggestions({ ...input, date: '2026-11-18' }, { create: mockCreate(items) }) });

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ SUG A', ${`zz-sug-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ SUG B', ${`zz-sug-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_sugtest_${stamp}_${n}`;
  const [owner, mgr, mgr2, rep1, rep2, viewer] = [U('own'), U('mgr'), U('mgr2'), U('r1'), U('r2'), U('view')];

  // Test appliers: same writes the real server actions make; stage goes through the real gate engine.
  const appliers: Appliers = {
    stage: ({ tenantId, userId, suggestion, value }) =>
      runWithTenantContext({ tenantId, userId }, () =>
        tenantTransaction(async (tx) => {
          const [d] = await tx.select({ stage: s.deals.stage }).from(s.deals).where(eq(s.deals.id, suggestion.entityId));
          const r = await evaluateStageTransition(tx, { tenantId, dealId: suggestion.entityId, fromStage: d!.stage, toStage: value as never });
          if (!r.allowed) return { ok: false as const, message: blockMessage(value as never, r.failures) };
          await tx.update(s.deals).set({ stage: value as never }).where(eq(s.deals.id, suggestion.entityId));
          return { ok: true as const };
        }),
      ),
    amount: ({ tenantId, userId, suggestion, value }) =>
      runWithTenantContext({ tenantId, userId }, () =>
        tenantTransaction(async (tx) => {
          await tx.update(s.deals).set({ amountMinor: toMinorUnits(Number(value), 'INR') }).where(eq(s.deals.id, suggestion.entityId));
          return { ok: true as const };
        }),
      ),
    close_date: ({ tenantId, userId, suggestion, value }) =>
      runWithTenantContext({ tenantId, userId }, () =>
        tenantTransaction(async (tx) => {
          await tx.update(s.deals).set({ expectedCloseDate: String(value) }).where(eq(s.deals.id, suggestion.entityId));
          return { ok: true as const };
        }),
      ),
    next_step: async () => ({ ok: false, message: 'not used' }),
    contact_name: async () => ({ ok: false, message: 'not used' }),
    contact_email: async () => ({ ok: false, message: 'not used' }),
    contact_phone: async () => ({ ok: false, message: 'not used' }),
    contact_designation: async () => ({ ok: false, message: 'not used' }),
    follow_up_task: async () => ({ ok: true }),
  };

  try {
    const ids = await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values([
          { tenantId: A, userId: owner, role: 'owner' },
          { tenantId: A, userId: mgr, role: 'manager' },
          { tenantId: A, userId: mgr2, role: 'manager' },
          { tenantId: A, userId: rep1, role: 'member', reportsToUserId: mgr },
          { tenantId: A, userId: rep2, role: 'member', reportsToUserId: mgr2 },
          { tenantId: A, userId: viewer, role: 'viewer' },
        ]);
        await tx.insert(s.organizationSettings).values({ tenantId: A, aiSuggestionsEnabled: true, timezone: 'Asia/Kolkata' });
        await tx.insert(s.workspaceSettings).values({ tenantId: A, stageGatesEnabled: true }).onConflictDoUpdate({ target: s.workspaceSettings.tenantId, set: { stageGatesEnabled: true } });
        await tx.insert(s.stageGates).values({ tenantId: A, stage: 'negotiation', ruleType: 'custom_note', ruleConfig: { prompt: 'Why?' }, severity: 'block', createdBy: owner });
        const [c] = await tx.insert(s.contacts).values({ tenantId: A, firstName: 'Ravi', lastName: 'Kumar', phone: '+91 98111 22233', ownerId: rep1 }).returning();
        const [d] = await tx
          .insert(s.deals)
          .values({ tenantId: A, name: 'Acme demo deal', stage: 'proposal', currency: 'INR', amountMinor: toMinorUnits(800000, 'INR'), expectedCloseDate: '2027-01-31', contactId: c!.id, ownerId: rep1 })
          .returning();
        const [call] = await tx
          .insert(s.calls)
          .values({ tenantId: A, provider: 'mock', providerCallId: `sug-${stamp}`, direction: 'outbound', userId: rep1, leadId: d!.id, contactId: c!.id, fromNumber: '+919800000001', toNumber: '+919811122233', status: 'completed', talkTimeSec: 120, transcript: TRANSCRIPT, transcriptStatus: 'done', startedAt: new Date('2026-11-18T06:00:00Z') })
          .returning();
        return { dealId: d!.id, contactId: c!.id, callId: call!.id };
      }),
    );
    const readDeal = () => runWithSystemContext(A, () => tenantTransaction(async (tx) => (await tx.select().from(s.deals).where(eq(s.deals.id, ids.dealId)))[0]!));
    const sugs = () => runWithSystemContext(A, () => tenantTransaction((tx) => tx.select().from(s.aiSuggestions).where(eq(s.aiSuggestions.tenantId, A))));

    // ------------------------------------------------ extraction from the call (demo scenario)
    const r1 = await suggestionsFromCallHandler({ event: { data: { tenantId: A, callId: ids.callId } }, step }, deps(demoItems));
    const after1 = await sugs();
    check('extract: two pending suggestions (close_date, amount); invalid stage dropped', r1.status === 'done' && after1.length === 2 && after1.every((x) => x.status === 'pending'), { r1, n: after1.length });
    const cd = after1.find((x) => x.field === 'close_date')!;
    const am = after1.find((x) => x.field === 'amount')!;
    check('extract: close_date 2026-12-15, current 2027-01-31, evidence quoted', cd?.suggestedValue === '2026-12-15' && cd.currentValueAtSuggestion === '2027-01-31' && cd.evidenceQuote.includes('15 December'));
    check('extract: amount 1200000, current 800000', am?.suggestedValue === 1200000 && am.currentValueAtSuggestion === 800000);
    check('extract: AI never wrote the deal', (await readDeal()).expectedCloseDate === '2027-01-31');
    const inv = await runWithSystemContext(A, () => tenantTransaction((tx) => tx.select().from(s.aiInvocations).where(and(eq(s.aiInvocations.tenantId, A), eq(s.aiInvocations.kind, 'ai_suggestions')))));
    check('extract: ai_invocations row with tokens + cost estimate', inv.length === 1 && inv[0]!.totalTokens === 1350 && Number((inv[0]!.metadata as Record<string, unknown>).costUsdEstimate) > 0);

    // ------------------------------------------------ idempotency
    const before = claudeCalls;
    const r2 = await suggestionsFromCallHandler({ event: { data: { tenantId: A, callId: ids.callId } }, step }, deps(demoItems));
    check('idempotent: same call again -> noop, Claude not called', r2.status === 'noop' && claudeCalls === before && (await sugs()).length === 2);

    // ------------------------------------------------ RBAC + tenant isolation
    const asUser = (tenantId: string, userId: string, fn: () => Promise<unknown>) => runWithTenantContext({ tenantId, userId }, fn as () => Promise<never>);
    const visible = async (userId: string, role: 'owner' | 'manager' | 'member' | 'viewer') =>
      (await asUser(A, userId, async () => svc.listSuggestions({ scope: await svc.suggestionScope(A, { userId, role }) })) as unknown as unknown[]).length;
    check('rbac: owning rep sees their 2', (await visible(rep1, 'member')) === 2);
    check("rbac: rep1's manager sees them (reports_to scope)", (await visible(mgr, 'manager')) === 2);
    check('rbac: another manager (not in the reporting line) sees none', (await visible(mgr2, 'manager')) === 0);
    check('rbac: another rep sees none', (await visible(rep2, 'member')) === 0);
    check('rbac: workspace owner sees them', (await visible(owner, 'owner')) === 2);
    const rep2Accept = (await asUser(A, rep2, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep2, role: 'member' }, id: cd.id, action: 'accept' }, appliers))) as { ok: boolean };
    check("rbac: another rep cannot accept rep1's suggestion", !rep2Accept.ok && (await readDeal()).expectedCloseDate === '2027-01-31');
    const viewerAccept = (await asUser(A, viewer, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: viewer, role: 'viewer' }, id: cd.id, action: 'accept' }, appliers))) as { ok: boolean };
    check('rbac: a viewer cannot accept', !viewerAccept.ok);
    const crossRows = (await asUser(B, 'usr_other', () => tenantTransaction((tx) => tx.select().from(s.aiSuggestions).where(eq(s.aiSuggestions.id, cd.id))))) as unknown[];
    check('isolation: tenant B cannot read tenant A suggestions (RLS)', crossRows.length === 0);
    const crossAccept = (await asUser(B, owner, () => svc.decideSuggestion({ tenantId: B, viewer: { userId: owner, role: 'owner' }, id: cd.id, action: 'accept' }, appliers))) as { ok: boolean };
    check('isolation: tenant B cannot accept tenant A suggestion', !crossAccept.ok);

    // ------------------------------------------------ accept: applies, logs activity
    const acc = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: cd.id, action: 'accept' }, appliers))) as { ok: boolean };
    const dealAfter = await readDeal();
    const cdAfter = (await sugs()).find((x) => x.id === cd.id)!;
    check('accept: deal close date updated through the applier', acc.ok && dealAfter.expectedCloseDate === '2026-12-15', acc);
    check('accept: status accepted, decided_by + applied_value set', cdAfter.status === 'accepted' && cdAfter.decidedBy === rep1 && cdAfter.appliedValue === '2026-12-15');
    const acts = await runWithSystemContext(A, () => tenantTransaction((tx) => tx.select().from(s.activityLogs).where(and(eq(s.activityLogs.tenantId, A), eq(s.activityLogs.entityId, ids.dealId)))));
    const accAct = acts.find((a) => a.action === 'ai_suggestion_accepted');
    const meta = (accAct?.metadata ?? {}) as Record<string, unknown>;
    check('accept: activity_logs row, AI-originated, with evidence and accepting user', !!accAct && meta.aiOriginated === true && String(meta.evidence).includes('15 December') && accAct.actorUserId === rep1 && meta.decidedBy === rep1);
    const again = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: cd.id, action: 'accept' }, appliers))) as { ok: boolean };
    check('accept: a decided suggestion cannot be accepted twice', !again.ok);

    // ------------------------------------------------ stale detection
    await runWithSystemContext(A, () => tenantTransaction((tx) => tx.update(s.deals).set({ amountMinor: toMinorUnits(950000, 'INR') }).where(eq(s.deals.id, ids.dealId))));
    const stale = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: am.id, action: 'accept' }, appliers))) as { ok: boolean; stale?: boolean; live?: unknown; atSuggestion?: unknown };
    const amAfter = (await sugs()).find((x) => x.id === am.id)!;
    check('stale: changed field -> not applied, diff returned', !stale.ok && stale.stale === true && stale.live === 950000 && stale.atSuggestion === 800000, stale);
    check('stale: deal keeps the newer value, suggestion marked stale with live value', Number((await readDeal()).amountMinor) === toMinorUnits(950000, 'INR') && amAfter.status === 'stale' && amAfter.liveValueAtDecision === 950000);

    // ------------------------------------------------ stage gate enforced on accept
    const [stageSug] = await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await svc.persistSuggestions(tx, { tenantId: A, sourceType: 'call', sourceId: `manual-${stamp}`, model: 'test', items: [{ entityType: 'deal', entityId: ids.dealId, field: 'stage', current: 'proposal', value: 'negotiation', evidenceQuote: "Let's close this by 15 December", confidence: 0.8 }] });
        return tx.select().from(s.aiSuggestions).where(and(eq(s.aiSuggestions.tenantId, A), eq(s.aiSuggestions.field, 'stage')));
      }),
    );
    const gated = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: stageSug!.id, action: 'accept' }, appliers))) as { ok: boolean; message?: string };
    const stageAfter = (await sugs()).find((x) => x.id === stageSug!.id)!;
    check('gate: blocked stage move returns the gate error', !gated.ok && /requirement/.test(gated.message ?? ''), gated);
    check('gate: deal stage unchanged, suggestion still pending and unclaimed', (await readDeal()).stage === 'proposal' && stageAfter.status === 'pending' && stageAfter.decidedAt === null);

    // ------------------------------------------------ edit-and-accept + reject
    const badEdit = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: stageSug!.id, action: 'edit', value: 'closed_won' }, appliers))) as { ok: boolean };
    check('edit: invalid edited value rejected, still pending', !badEdit.ok && (await sugs()).find((x) => x.id === stageSug!.id)!.status === 'pending');
    const rej = (await asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: stageSug!.id, action: 'reject', note: 'Not yet' }, appliers))) as { ok: boolean };
    const rejRow = (await sugs()).find((x) => x.id === stageSug!.id)!;
    check('reject: nothing changes on the deal, status rejected with note', rej.ok && rejRow.status === 'rejected' && rejRow.decisionNote === 'Not yet' && (await readDeal()).stage === 'proposal');
    const rejAct = (await runWithSystemContext(A, () => tenantTransaction((tx) => tx.select().from(s.activityLogs).where(and(eq(s.activityLogs.entityId, ids.dealId), eq(s.activityLogs.action, 'ai_suggestion_rejected')))))).length;
    check('reject: logged to activity_logs', rejAct === 1);

    // ------------------------------------------------ supersede
    await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await svc.persistSuggestions(tx, { tenantId: A, sourceType: 'email', sourceId: `t1:1`, model: 'test', items: [{ entityType: 'deal', entityId: ids.dealId, field: 'next_step', current: null, value: 'Send proposal v1', evidenceQuote: 'x', confidence: 0.7 }] });
        await svc.persistSuggestions(tx, { tenantId: A, sourceType: 'email', sourceId: `t1:2`, model: 'test', items: [{ entityType: 'deal', entityId: ids.dealId, field: 'next_step', current: null, value: 'Send proposal v2', evidenceQuote: 'y', confidence: 0.7 }] });
      }),
    );
    const ns = (await sugs()).filter((x) => x.field === 'next_step');
    check('supersede: newer pending suggestion supersedes the older one', ns.find((x) => x.suggestedValue === 'Send proposal v1')?.status === 'superseded' && ns.find((x) => x.suggestedValue === 'Send proposal v2')?.status === 'pending');

    // ------------------------------------------------ concurrent accepts
    const [ns2] = ns.filter((x) => x.status === 'pending');
    let applyCount = 0;
    const slowAppliers: Appliers = { ...appliers, next_step: async () => { applyCount++; await new Promise((r) => setTimeout(r, 150)); return { ok: true }; } };
    const both = (await Promise.all([
      asUser(A, rep1, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: rep1, role: 'member' }, id: ns2!.id, action: 'accept' }, slowAppliers)),
      asUser(A, mgr, () => svc.decideSuggestion({ tenantId: A, viewer: { userId: mgr, role: 'manager' }, id: ns2!.id, action: 'accept' }, slowAppliers)),
    ])) as Array<{ ok: boolean }>;
    check('concurrency: two simultaneous accepts apply once', both.filter((x) => x.ok).length === 1 && applyCount === 1, { both, applyCount });

    // ------------------------------------------------ follow-up folded into the queue
    await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await tx.update(s.calls).set({ aiSummary: { summary: 'Will close mid December.', next_steps: ['Send revised proposal'], sentiment: 'positive', objections: [], competitor_mentions: [], suggested_disposition: 'interested', follow_up_date: '2026-12-01' } as never, aiSummaryStatus: 'done' }).where(eq(s.calls.id, ids.callId));
        const [c] = await tx.select().from(s.calls).where(eq(s.calls.id, ids.callId));
        await svc.recordFollowUpSuggestion(tx, c!);
        await svc.recordFollowUpSuggestion(tx, c!);
      }),
    );
    const fu = (await sugs()).filter((x) => x.field === 'follow_up_task');
    const fuId = await runWithSystemContext(A, () => svc.pendingFollowUpForCall(A, ids.callId));
    check('follow-up: summary follow-up is one pending follow_up_task suggestion', fu.length === 1 && fuId === fu[0]!.id && (fu[0]!.suggestedValue as { due_date: string }).due_date === '2026-12-01');

    // ------------------------------------------------ badge + metrics + gate off
    const badge = await asUser(A, rep1, () => svc.countMyPending(A, rep1));
    check('badge: counts the rep’s own pending items', badge === 1, badge);
    const metrics = await runWithSystemContext(A, () => svc.suggestionMetrics(A));
    const cdm = metrics.byField.find((m) => m.key === 'close_date');
    const stm = metrics.byField.find((m) => m.key === 'stage');
    check('metrics: acceptance by field (close_date 100%, stage 0%)', cdm?.rate === 1 && stm?.rate === 0, metrics.byField);
    check('metrics: by model includes the extractor model', metrics.byModel.some((m) => m.key === 'claude-sonnet-5-5'));
    await runWithSystemContext(A, () => tenantTransaction((tx) => tx.update(s.organizationSettings).set({ aiSuggestionsEnabled: false }).where(eq(s.organizationSettings.tenantId, A))));
    const callsBefore = claudeCalls;
    const off = await runWithSystemContext(A, () => svc.runSuggestionsForCall(A, ids.callId, deps(demoItems)));
    check('setting off: skipped, Claude not called', off.status === 'skipped' && claudeCalls === callsBefore);
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nai-suggestions db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
