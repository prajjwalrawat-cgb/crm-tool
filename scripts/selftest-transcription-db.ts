import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });
config();

/**
 * DB-backed self-test for call transcription (0076). Creates two throwaway
 * tenants and deletes them at the end. Providers and storage are injected
 * (no network): this tests the workflow, claim, persistence, RBAC and RLS.
 *
 *   tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-transcription-db.ts
 *
 * Covers: transcript + speaker turns persisted, idempotency (duplicate events,
 * concurrent claims), non-retryable and retryable failures (fail soft, call
 * row untouched), workspace switch / consent / length gates, ai_invocations
 * and recording-access logging, tenant isolation and call-scope RBAC for
 * transcript reads and retries, and the transcript -> summary -> follow-up
 * chain with an injected summariser.
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
  const { callTranscribeHandler, callAiSummarizeHandler } = await import('../src/lib/inngest/workflows/telephony');
  const { prepareTranscription, canRetryTranscription } = await import('../src/lib/telephony/transcription');
  const { getCallScoped, acceptFollowUp } = await import('../src/lib/telephony/service');
  const { serializeCall } = await import('../src/lib/telephony/serialize');
  const { SttError } = await import('../src/lib/telephony/stt/core');
  type Transcriber = import('../src/lib/telephony/stt/core').Transcriber;

  const step = { run: <T,>(_id: string, fn: () => Promise<T>) => fn(), sleep: async () => {} };

  // Stereo WAV header: the probe reports 2 channels.
  const wav = new Uint8Array(44);
  wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  wav.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8);
  new DataView(wav.buffer).setUint32(16, 16, true);
  new DataView(wav.buffer).setUint16(22, 2, true);
  new DataView(wav.buffer).setUint32(24, 8000, true);
  const loadAudio = async () => ({ bytes: wav, contentType: 'audio/wav' });

  let okCalls = 0;
  let seenChannels: number | null = null;
  const okTranscriber: Transcriber = {
    name: 'mock-stt',
    model: 'mock-1',
    configured: () => true,
    async transcribe(audio, opts) {
      okCalls++;
      seenChannels = audio.channels;
      const segments = [
        { speaker: opts.channelRoles[0], startMs: 0, endMs: 3000, text: "Sir, when do you want to close this?", confidence: 0.9 },
        { speaker: opts.channelRoles[1], startMs: 3500, endMs: 9000, text: "Let's close this by 15 December, budget is around 12 lakh.", confidence: 0.85 },
      ];
      return { text: segments.map((x) => `${x.speaker === 'agent' ? 'Agent' : 'Customer'}: ${x.text}`).join('\n'), segments, language: 'en-IN', durationMs: 120000, provider: 'mock-stt', model: 'mock-1', channelSeparated: true };
    },
  };
  const hardFail: Transcriber = { ...okTranscriber, async transcribe() { throw new SttError('mock-stt listen failed: HTTP 400 (bad audio)', false, 400); } };
  let retryCalls = 0;
  const softFail: Transcriber = { ...okTranscriber, async transcribe() { retryCalls++; throw new SttError('mock-stt listen failed: HTTP 503', true, 503); } };

  const stamp = Date.now();
  const [ta] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ STT A', ${`zz-stt-a-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const [tb] = (await db.execute(sql`INSERT INTO tenants (name, slug) VALUES ('ZZ STT B', ${`zz-stt-b-${stamp}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  const A = ta!.id;
  const B = tb!.id;
  const U = (n: string) => `usr_stttest_${stamp}_${n}`;
  const [rep1, rep2, mgr] = [U('r1'), U('r2'), U('mgr')];

  try {
    const mk = (tenantId: string, userId: string, over: Partial<typeof s.calls.$inferInsert> = {}) => ({
      tenantId,
      provider: 'mock' as const,
      providerCallId: `stt-${stamp}-${Math.random().toString(36).slice(2)}`,
      direction: 'outbound' as const,
      userId,
      fromNumber: '+919800000001',
      toNumber: '+919811122233',
      status: 'completed' as const,
      disposition: 'interested' as const,
      talkTimeSec: 120,
      durationSec: 130,
      recordingStorageKey: `tenant/${tenantId}/calls/x.mp3`,
      ...over,
    });

    const ids = await runWithSystemContext(A, () =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.memberships).values([
          { tenantId: A, userId: rep1, role: 'member' },
          { tenantId: A, userId: rep2, role: 'member' },
          { tenantId: A, userId: mgr, role: 'manager' },
        ]);
        await tx.insert(s.telephonySettings).values({ tenantId: A, transcriptionEnabled: true, transcriptionConsentAt: new Date(), transcriptionConsentBy: mgr, aiCallSummary: true });
        const [d] = await tx.insert(s.deals).values({ tenantId: A, name: 'STT deal', stage: 'qualified', currency: 'INR', ownerId: rep1 }).returning();
        const rows = await tx
          .insert(s.calls)
          .values([
            mk(A, rep1, { leadId: d!.id }),
            mk(A, rep2),
            mk(A, rep1),
            mk(A, rep1, { talkTimeSec: 4, durationSec: 6 }),
            mk(A, rep1, { recordingStorageKey: null }),
          ])
          .returning({ id: s.calls.id });
        return { dealId: d!.id, ok: rows[0]!.id, hard: rows[1]!.id, soft: rows[2]!.id, short: rows[3]!.id, norec: rows[4]!.id };
      }),
    );
    const callB = await runWithSystemContext(B, () =>
      tenantTransaction(async (tx) => {
        await tx.insert(s.telephonySettings).values({ tenantId: B });
        const [c] = await tx.insert(s.calls).values(mk(B, 'usr_other')).returning({ id: s.calls.id });
        return c!.id;
      }),
    );
    const read = (tenantId: string, id: string) =>
      runWithSystemContext(tenantId, () => tenantTransaction(async (tx) => (await tx.select().from(s.calls).where(eq(s.calls.id, id)))[0]!));

    // ------------------------------------------------ happy path
    const out = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.ok } }, step }, { transcriber: okTranscriber, loadAudio });
    const c1 = await read(A, ids.ok);
    check('transcribe: workflow returns done', out.status === 'done', out);
    check('transcribe: status done + provider/model/language stored', c1.transcriptStatus === 'done' && c1.transcriptProvider === 'mock-stt' && c1.transcriptModel === 'mock-1' && c1.transcriptLanguage === 'en-IN');
    check('transcribe: speaker turns stored (agent, customer)', c1.transcriptSegments?.map((x) => x.speaker).join(',') === 'agent,customer', c1.transcriptSegments);
    check('transcribe: plain transcript has Agent:/Customer: lines', !!c1.transcript?.startsWith('Agent: ') && c1.transcript.includes('\nCustomer: '));
    check('transcribe: dual-channel detected from the file header', seenChannels === 2);
    check('transcribe: call row otherwise untouched', c1.status === 'completed' && c1.disposition === 'interested' && c1.talkTimeSec === 120);
    const audit = await runWithSystemContext(A, () =>
      tenantTransaction((tx) => tx.select().from(s.aiInvocations).where(and(eq(s.aiInvocations.tenantId, A), eq(s.aiInvocations.kind, 'stt')))),
    );
    check('transcribe: ai_invocations row (stt, success, provider, audio seconds)', audit.length === 1 && audit[0]!.status === 'success' && (audit[0]!.metadata as Record<string, unknown>).provider === 'mock-stt' && (audit[0]!.metadata as Record<string, unknown>).audioSeconds === 120, audit[0]?.metadata);
    check('transcribe: ai_invocations metadata carries no transcript text', !JSON.stringify(audit[0]?.metadata ?? {}).includes('lakh'));
    const access = await runWithSystemContext(A, () =>
      tenantTransaction((tx) => tx.select().from(s.callRecordingAccess).where(eq(s.callRecordingAccess.callId, ids.ok))),
    );
    check('transcribe: recording access logged (system, stt:mock-stt)', access.length === 1 && access[0]!.userId === 'system' && access[0]!.rangeHeader === 'stt:mock-stt');

    // ------------------------------------------------ idempotency
    const again = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.ok } }, step }, { transcriber: okTranscriber, loadAudio });
    check('idempotent: second event is a no-op', again.status === 'noop' && okCalls === 1, again);
    const [p1, p2] = await Promise.all([
      runWithSystemContext(A, () => prepareTranscription(A, ids.soft, { transcriber: okTranscriber })),
      runWithSystemContext(A, () => prepareTranscription(A, ids.soft, { transcriber: okTranscriber })),
    ]);
    check('idempotent: concurrent claims -> exactly one wins', [p1.status, p2.status].filter((x) => x === 'claimed').length === 1, [p1, p2]);
    // Release that claim so the retryable-failure case below can run.
    await runWithSystemContext(A, () => tenantTransaction((tx) => tx.update(s.calls).set({ transcriptStatus: null, transcriptStartedAt: null }).where(eq(s.calls.id, ids.soft))));

    // ------------------------------------------------ failures (fail soft)
    const hard = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.hard } }, step }, { transcriber: hardFail, loadAudio });
    const c2 = await read(A, ids.hard);
    check('fail: non-retryable error -> failed after one attempt', hard.status === 'failed' && c2.transcriptStatus === 'failed' && c2.transcriptAttempts === 1, { hard, attempts: c2.transcriptAttempts });
    check('fail: short reason stored, call row untouched', !!c2.transcriptError?.includes('HTTP 400') && c2.status === 'completed' && c2.disposition === 'interested' && c2.transcript === null);
    const soft = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.soft } }, step }, { transcriber: softFail, loadAudio });
    const c3 = await read(A, ids.soft);
    check('fail: retryable error retried with backoff (4 attempts) then failed', soft.status === 'failed' && retryCalls === 4 && c3.transcriptAttempts === 4, { retryCalls, attempts: c3.transcriptAttempts });
    const tooBig = await callTranscribeHandler(
      { event: { data: { tenantId: A, callId: ids.soft } }, step },
      { transcriber: okTranscriber, loadAudio: async () => { const { RecordingTooLargeError } = await import('../src/lib/telephony/storage'); throw new RecordingTooLargeError(1024); } },
    );
    check('fail: oversized recording fails without retry', tooBig.status === 'failed' && (await read(A, ids.soft)).transcriptError?.includes('MB limit') === true, tooBig);

    // ------------------------------------------------ gates
    const short = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.short } }, step }, { transcriber: okTranscriber, loadAudio });
    check('gate: too-short call skipped', short.status === 'skipped' && (await read(A, ids.short)).transcriptStatus === 'skipped');
    const norec = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.norec } }, step }, { transcriber: okTranscriber, loadAudio });
    check('gate: no recording -> noop', norec.status === 'noop');
    const off = await callTranscribeHandler({ event: { data: { tenantId: B, callId: callB } }, step }, { transcriber: okTranscriber, loadAudio });
    const cb = await read(B, callB);
    check('gate: workspace with transcription off -> skipped with reason', off.status === 'skipped' && cb.transcriptStatus === 'skipped' && /turned off/.test(cb.transcriptError ?? ''));
    await runWithSystemContext(B, () => tenantTransaction((tx) => tx.update(s.telephonySettings).set({ transcriptionEnabled: true }).where(eq(s.telephonySettings.tenantId, B))));
    const noConsent = await callTranscribeHandler({ event: { data: { tenantId: B, callId: callB } }, step }, { transcriber: okTranscriber, loadAudio });
    check('gate: enabled without consent -> still skipped', noConsent.status === 'skipped' && /consent/i.test((noConsent as { reason?: string }).reason ?? ''));
    const noProvider = await runWithSystemContext(A, () => prepareTranscription(A, ids.short, {}));
    check('gate: no provider selected in settings -> skipped', noProvider.status === 'skipped', noProvider);

    // ------------------------------------------------ tenant isolation + RBAC
    const crossTenant = await runWithTenantContext({ tenantId: B, userId: 'usr_other' }, () =>
      tenantTransaction((tx) => tx.select({ t: s.calls.transcript }).from(s.calls).where(eq(s.calls.id, ids.ok))),
    );
    check('isolation: tenant B cannot read tenant A transcript', crossTenant.length === 0);
    const asRep2 = await runWithTenantContext({ tenantId: A, userId: rep2 }, () => getCallScoped(A, { userId: rep2, role: 'member' }, ids.ok));
    check("rbac: a rep cannot read another rep's call transcript", asRep2 === null);
    const asMgr = await runWithTenantContext({ tenantId: A, userId: mgr }, () => getCallScoped(A, { userId: mgr, role: 'manager' }, ids.ok));
    check('rbac: manager can read it; serializer includes turns', !!asMgr && serializeCall(asMgr, { includeTranscript: true }).transcriptSegments?.length === 2);
    check('serialize: list view (no includeTranscript) omits text and turns', (() => { const x = serializeCall(asMgr!); return x.transcript === null && x.transcriptSegments === null && x.transcriptStatus === 'done'; })());
    const r1 = await runWithTenantContext({ tenantId: A, userId: rep1 }, () => canRetryTranscription({ tenantId: A, viewer: { userId: rep1, role: 'member' }, callId: ids.hard }));
    check("retry: rep cannot retry another rep's call", !r1.ok);
    const r2 = await runWithTenantContext({ tenantId: A, userId: rep2 }, () => canRetryTranscription({ tenantId: A, viewer: { userId: rep2, role: 'member' }, callId: ids.hard }));
    check('retry: owner of a failed call can retry', r2.ok, r2);
    const r3 = await runWithTenantContext({ tenantId: A, userId: mgr }, () => canRetryTranscription({ tenantId: A, viewer: { userId: mgr, role: 'manager' }, callId: ids.ok }));
    check('retry: a done transcript cannot be retried', !r3.ok);
    const r4 = await runWithTenantContext({ tenantId: B, userId: mgr }, () => canRetryTranscription({ tenantId: B, viewer: { userId: mgr, role: 'owner' }, callId: ids.hard }));
    check('retry: another tenant cannot retry (call not found)', !r4.ok);
    const retried = await callTranscribeHandler({ event: { data: { tenantId: A, callId: ids.hard, requestedBy: rep2 } }, step }, { transcriber: okTranscriber, loadAudio });
    const c2b = await read(A, ids.hard);
    check('retry: a failed call is re-claimed and transcribed', retried.status === 'done' && c2b.transcriptStatus === 'done');
    const retryAccess = await runWithSystemContext(A, () =>
      tenantTransaction((tx) => tx.select().from(s.callRecordingAccess).where(and(eq(s.callRecordingAccess.callId, ids.hard), eq(s.callRecordingAccess.userId, rep2)))),
    );
    check('retry: recording access attributed to the requesting user', retryAccess.length === 1);

    // ------------------------------------------------ transcript -> summary -> follow-up
    const summary = await callAiSummarizeHandler({
      event: { data: { tenantId: A, callId: ids.ok } },
      step,
      summarize: async () => ({
        ok: true as const,
        attempts: 1,
        usage: { inputTokens: 300, outputTokens: 80, latencyMs: 12, model: 'claude-sonnet-5-5' },
        summary: {
          summary: 'Customer plans to close by 15 December with a budget around 12 lakh.',
          next_steps: ['Send the proposal'],
          sentiment: 'positive' as const,
          objections: [],
          competitor_mentions: [],
          suggested_disposition: 'interested',
          follow_up_date: '2026-12-15',
        } as never,
      }),
    });
    const c1s = await read(A, ids.ok);
    check('summary: runs on the transcript and stores the summary', (summary as { status: string }).status === 'done' && c1s.aiSummaryStatus === 'done' && c1s.aiSummary?.follow_up_date === '2026-12-15', summary);
    const sAudit = await runWithSystemContext(A, () =>
      tenantTransaction((tx) => tx.select().from(s.aiInvocations).where(and(eq(s.aiInvocations.tenantId, A), eq(s.aiInvocations.kind, 'call_summary')))),
    );
    check('summary: logged to ai_invocations with tokens', sAudit.length === 1 && sAudit[0]!.totalTokens === 380);
    const fu = await runWithTenantContext({ tenantId: A, userId: rep1 }, () => acceptFollowUp({ tenantId: A, userId: rep1, role: 'member', callId: ids.ok }));
    check('follow-up: "Accept follow-up task" creates the task', fu.ok === true);
    await runWithSystemContext(A, () => tenantTransaction((tx) => tx.update(s.telephonySettings).set({ aiCallSummary: false }).where(eq(s.telephonySettings.tenantId, A))));
    const disabled = await callAiSummarizeHandler({ event: { data: { tenantId: A, callId: ids.hard } }, step, summarize: async () => { throw new Error('must not be called'); } });
    check('summary: ai_call_summary off -> Claude not called', (disabled as { status: string }).status === 'disabled');
  } catch (err) {
    check('selftest ran without throwing', false, String(err instanceof Error ? err.stack : err));
  } finally {
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${A}, ${B})`);
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  ${r.detail}` : ''}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\ntranscription db selftest: ${passed} passed, ${results.length - passed} failed`);
  await client.end({ timeout: 5 });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('selftest fatal:', err);
  process.exit(1);
});
