import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();
// .env.local may hold a real key: this test must never reach Claude.
process.env.ANTHROPIC_API_KEY = '';

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
  const { prospectAppliers } = await import('../src/lib/ai/suggestions/prospect-appliers');
  const { toSuggestionView, formatSuggestionValue } = await import('../src/lib/ai/suggestions/view');
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
    // Prospect fields (0079): the real appliers (updateProspect as the accepting user; no session needed).
    ...prospectAppliers,
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

    // ------------------------------------------------ Inngest retries re-run the extraction
    const retryCallId = await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await tx.update(s.organizationSettings).set({ aiSuggestionsEnabled: true }).where(eq(s.organizationSettings.tenantId, A));
        const [call] = await tx
          .insert(s.calls)
          .values({ tenantId: A, provider: 'mock', providerCallId: `sug-retry-${stamp}`, direction: 'outbound', userId: rep1, leadId: ids.dealId, contactId: ids.contactId, fromNumber: '+919800000001', toNumber: '+919811122233', status: 'completed', talkTimeSec: 60, transcript: TRANSCRIPT, transcriptStatus: 'done', startedAt: new Date('2026-11-19T06:00:00Z') })
          .returning();
        return call!.id;
      }),
    );
    // A step stub that re-runs its callback when it throws, like Inngest retrying a step.
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
      sleep: async () => {},
    };
    const failUsage = { inputTokens: 0, outputTokens: 0, latencyMs: 0, model: 'test', costUsd: 0 };
    let extractRuns = 0;
    const failing = (retryable: boolean) => ({
      extract: async () => {
        extractRuns++;
        return { ok: false as const, error: 'model busy', retryable, usage: failUsage };
      },
    });
    let handlerThrew = false;
    try {
      await suggestionsFromCallHandler({ event: { data: { tenantId: A, callId: retryCallId } }, step: retryingStep }, failing(true));
    } catch {
      handlerThrew = true;
    }
    check('retry: retryable failure throws inside the step, so each retry re-runs the extraction', handlerThrew && stepAttempts === 3 && extractRuns === 3, { handlerThrew, stepAttempts, extractRuns });
    stepAttempts = 0;
    extractRuns = 0;
    const nr = await suggestionsFromCallHandler({ event: { data: { tenantId: A, callId: retryCallId } }, step: retryingStep }, failing(false));
    check('retry: non-retryable failure returns normally (one attempt, no throw)', nr.status === 'failed' && stepAttempts === 1 && extractRuns === 1, { nr, stepAttempts, extractRuns });

    // ------------------------------------------------ prospect suggestions (Stage 3 Task 7)
    const pids = await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        const [o1] = await tx.insert(s.offerings).values({ tenantId: A, name: 'CRM Suite', category: 'product' }).returning();
        const [o2] = await tx.insert(s.offerings).values({ tenantId: A, name: 'Old Thing', category: 'product', active: false }).returning();
        const old = new Date(Date.now() - 3 * 86_400_000);
        const future = new Date(Date.now() + 3 * 86_400_000);
        const [p1] = await tx.insert(s.prospects).values({ tenantId: A, companyName: 'Doon Biotech', sourceTag: 'test', createdBy: rep2, claimedBy: rep1, claimExpiresAt: future, lastActivityAt: old }).returning();
        const [p2] = await tx.insert(s.prospects).values({ tenantId: A, companyName: 'Unclaimed Co', sourceTag: 'test', createdBy: rep1, lastActivityAt: old }).returning();
        const [p3] = await tx.insert(s.prospects).values({ tenantId: A, companyName: 'Promoted Co', sourceTag: 'test', createdBy: rep1, promotedDealId: ids.dealId, lastActivityAt: old }).returning();
        type F = import('../src/db/schema').SuggestionField;
        type V = import('../src/db/schema').SuggestionValue;
        const enrich = (pid: string, items: Array<{ field: F; value: V }>) =>
          svc.persistSuggestions(tx, {
            tenantId: A,
            sourceType: 'enrichment',
            sourceId: pid,
            model: 'test',
            items: items.map((i) => ({ entityType: 'prospect' as const, entityId: pid, field: i.field, current: null, value: i.value, evidenceQuote: 'reasoning', confidence: 0.8 })),
          });
        await enrich(p1!.id, [{ field: 'industry', value: 'Biotechnology' }, { field: 'size_band', value: '11-50' }]);
        await enrich(p2!.id, [{ field: 'product_fit', value: o1!.id }, { field: 'icp_score', value: 72 }, { field: 'industry', value: 'Retail' }, { field: 'size_band', value: '51-200' }]);
        await enrich(p3!.id, [{ field: 'industry', value: 'Pharma' }]);
        return { o1: o1!.id, o2: o2!.id, p1: p1!.id, p2: p2!.id, p3: p3!.id, old };
      }),
    );
    const pSug = async (pid: string, field: string) => (await sugs()).find((x) => x.entityId === pid && x.field === field)!;
    const readP = (pid: string) => runWithSystemContext(A, () => tenantTransaction(async (tx) => (await tx.select().from(s.prospects).where(eq(s.prospects.id, pid)))[0]!));
    const prospectRows = async (userId: string, role: 'owner' | 'manager' | 'member') =>
      (await asUser(A, userId, async () =>
        svc.listSuggestions({ scope: await svc.suggestionScope(A, { userId, role }), entity: { type: 'prospect', ids: [pids.p1, pids.p2, pids.p3] } }),
      )) as Awaited<ReturnType<typeof svc.listSuggestions>>;
    const decideAs = (userId: string, role: 'owner' | 'manager' | 'member', id: string, action: 'accept' | 'reject' | 'edit', value?: unknown) =>
      asUser(A, userId, () => svc.decideSuggestion({ tenantId: A, viewer: { userId, role }, id, action, value }, appliers)) as Promise<{ ok: boolean; message?: string; stale?: boolean; live?: unknown }>;

    const r1Rows = await prospectRows(rep1, 'member');
    check('suggest: prospect suggestion visible to its claimer, and to creator when unclaimed', r1Rows.length === 7 && r1Rows.some((r) => r.entityId === pids.p1) && r1Rows.some((r) => r.entityId === pids.p2), r1Rows.length);
    const p1Row = r1Rows.find((r) => r.entityId === pids.p1 && r.field === 'industry');
    check('suggest: prospect owner = claimer, name = company name', p1Row?.ownerId === rep1 && p1Row.entityName === 'Doon Biotech', { owner: p1Row?.ownerId, name: p1Row?.entityName });
    check("suggest: manager sees team's prospect suggestions", (await prospectRows(mgr, 'manager')).length === 7);
    check('suggest: other manager sees none', (await prospectRows(mgr2, 'manager')).length === 0);
    check("suggest: other rep doesn't (even the creator of a prospect someone else claimed)", (await prospectRows(rep2, 'member')).length === 0);
    const badgeP = await asUser(A, rep1, () => svc.countMyPending(A, rep1));
    check('badge: counts prospect suggestions the rep owns', badgeP === 1 + 7, badgeP);

    // View: link, offering name resolved server-side, ICP formatting.
    const pfRow = r1Rows.find((r) => r.field === 'product_fit');
    const pfView = pfRow ? toSuggestionView(pfRow) : null;
    check('view: prospect link /dashboard/prospects?p=<id>', pfView?.entityHref === `/dashboard/prospects?p=${pids.p2}`, pfView?.entityHref);
    check('view: product fit shows the offering name', !!pfView && formatSuggestionValue('product_fit', pfView.suggested, pfView.valueLabels) === 'CRM Suite', pfView?.valueLabels);
    check('view: product fit edit options are the active offerings only', JSON.stringify(pfView?.options) === JSON.stringify([{ value: pids.o1, label: 'CRM Suite' }]), pfView?.options);
    check('view: ICP shown as NN / 100, size band as-is', formatSuggestionValue('icp_score', 72) === '72 / 100' && formatSuggestionValue('size_band', '51-200') === '51-200');

    // RBAC on decide.
    const rep2Try = await decideAs(rep2, 'member', (await pSug(pids.p1, 'industry')).id, 'accept');
    check('accept: a rep outside scope cannot accept a prospect suggestion', !rep2Try.ok && (await readP(pids.p1)).industry === null);

    // Accept industry.
    const accInd = await decideAs(rep1, 'member', (await pSug(pids.p1, 'industry')).id, 'accept');
    const p1After = await readP(pids.p1);
    check('accept: writes industry via updateProspect and bumps activity', accInd.ok && p1After.industry === 'Biotechnology' && p1After.lastActivityAt.getTime() > pids.old.getTime() + 60_000, accInd);
    check('accept: suggestion accepted', (await pSug(pids.p1, 'industry')).status === 'accepted');
    const pActs = await runWithSystemContext(A, () => tenantTransaction((tx) => tx.select().from(s.activityLogs).where(and(eq(s.activityLogs.tenantId, A), eq(s.activityLogs.entityId, pids.p1)))));
    check('accept: decision logged on the prospect (entity type prospect)', pActs.some((a) => a.action === 'ai_suggestion_accepted' && a.entityType === 'prospect' && a.actorUserId === rep1), pActs.map((a) => [a.entityType, a.action]));

    // Product fit: edit with an inactive offering is refused; accept sets the id.
    const pfId = (await pSug(pids.p2, 'product_fit')).id;
    const badPf = await decideAs(rep1, 'member', pfId, 'edit', pids.o2);
    check('edit: product fit must be an active offering', !badPf.ok && (await pSug(pids.p2, 'product_fit')).status === 'pending' && (await readP(pids.p2)).productFitOfferingId === null, badPf);
    const accPf = await decideAs(rep1, 'member', pfId, 'accept');
    check('accept: product_fit sets offering id', accPf.ok && (await readP(pids.p2)).productFitOfferingId === pids.o1, accPf);

    // ICP edit-and-accept, size band accepted by the manager.
    const icp = await decideAs(rep1, 'member', (await pSug(pids.p2, 'icp_score')).id, 'edit', '80');
    check('edit: icp_score edited to 80 and applied', icp.ok && (await readP(pids.p2)).icpScore === 80, icp);
    const sb = await decideAs(mgr, 'manager', (await pSug(pids.p2, 'size_band')).id, 'accept');
    check('accept: size_band applied by the manager', sb.ok && (await readP(pids.p2)).sizeBand === '51-200', sb);

    // Promoted prospect: updateProspect refuses; the suggestion stays pending (claim released).
    const prom = await decideAs(rep1, 'member', (await pSug(pids.p3, 'industry')).id, 'accept');
    const promRow = await pSug(pids.p3, 'industry');
    check("accept: promoted prospect -> not applied, error 'Already promoted to a lead.', stays pending", !prom.ok && prom.message === 'Already promoted to a lead.' && promRow.status === 'pending' && promRow.decidedAt === null && (await readP(pids.p3)).industry === null, { prom, status: promRow.status });

    // Reject: no write.
    const p1Before = await readP(pids.p1);
    const rejP = await decideAs(rep1, 'member', (await pSug(pids.p1, 'size_band')).id, 'reject');
    const p1Rej = await readP(pids.p1);
    check('reject: no write', rejP.ok && p1Rej.sizeBand === null && p1Rej.updatedAt.getTime() === p1Before.updatedAt.getTime() && (await pSug(pids.p1, 'size_band')).status === 'rejected');

    // Stale: industry changed after the suggestion was made.
    await runWithSystemContext(A, () => tenantTransaction((tx) => tx.update(s.prospects).set({ industry: 'Food' }).where(eq(s.prospects.id, pids.p2))));
    const st = await decideAs(rep1, 'member', (await pSug(pids.p2, 'industry')).id, 'accept');
    check('stale: field changed after suggestion -> stale on decide', !st.ok && st.stale === true && st.live === 'Food' && (await pSug(pids.p2, 'industry')).status === 'stale' && (await readP(pids.p2)).industry === 'Food', st);
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
