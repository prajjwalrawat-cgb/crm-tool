import { config } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';

import { DEMO_TENANT_NAMES, isDemoTenant } from './demo-allowlist';

config({ path: '.env.local' });
config();

/**
 * Demo scenario for AI suggestions: a deal + contact + a transcribed call
 * where the customer says "let's close this by 15 December, budget is around
 * 12 lakh", then runs the call extractor so the deal page shows pending
 * suggestions for close_date and amount.
 *
 *   pnpm seed:ai-suggestions-demo            # real Claude if ANTHROPIC_API_KEY is set
 *   pnpm seed:ai-suggestions-demo -- --mock  # deterministic mock model (no network)
 *
 * Writes ONLY into an allowlisted demo tenant (scripts/demo-allowlist.ts,
 * override with DEMO_TENANT_NAME). Turns ai_suggestions_enabled on for that
 * tenant. Re-running creates a fresh deal/call each time.
 *
 * Verify:
 *   select field, current_value_at_suggestion, suggested_value, status
 *   from ai_suggestions order by created_at desc limit 10;
 */

const MOCK = process.argv.includes('--mock');
const TRANSCRIPT = [
  'Agent: Good afternoon sir, this is Priya from the Saleinx team. Did you get a chance to review the proposal?',
  'Customer: Yes, we went through it with our finance head.',
  'Agent: Great. When are you planning to finalise?',
  "Customer: Let's close this by 15 December, budget is around 12 lakh.",
  'Agent: Perfect, I will send the revised proposal with the updated scope today.',
].join('\n');

async function main() {
  const { db, client } = await import('../src/db/index');
  const s = await import('../src/db/schema');
  const { runWithSystemContext, tenantTransaction } = await import('../src/lib/db-context');
  const { runSuggestionsForCall } = await import('../src/lib/ai/suggestions/service');
  const { extractSuggestions, suggestionsClaudeConfigured } = await import('../src/lib/ai/suggestions/extract');
  const { toMinorUnits } = await import('../src/lib/deals/currency');

  const wanted = process.env.DEMO_TENANT_NAME ?? DEMO_TENANT_NAMES[0]!;
  if (!isDemoTenant(wanted)) throw new Error(`"${wanted}" is not in the demo allowlist (${DEMO_TENANT_NAMES.join(', ')}).`);
  const [tenant] = (await db.execute(sql`SELECT id, name FROM tenants WHERE name = ${wanted} LIMIT 1`)) as unknown as Array<{ id: string; name: string }>;
  if (!tenant) throw new Error(`Demo tenant "${wanted}" not found. Create it first.`);
  const T = tenant.id;

  if (!MOCK && !suggestionsClaudeConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set. Re-run with --mock for a deterministic demo, or set the key for a real Claude run.');
    process.exit(2);
  }

  const ids = await runWithSystemContext(T, () =>
    tenantTransaction(async (tx) => {
      const members = await tx.select({ userId: s.memberships.userId, role: s.memberships.role }).from(s.memberships).where(eq(s.memberships.tenantId, T));
      const rep = members.find((m) => m.role === 'member') ?? members[0];
      if (!rep) throw new Error('Demo tenant has no members.');
      await tx
        .insert(s.organizationSettings)
        .values({ tenantId: T, aiSuggestionsEnabled: true })
        .onConflictDoUpdate({ target: s.organizationSettings.tenantId, set: { aiSuggestionsEnabled: true } });
      const [c] = await tx.insert(s.contacts).values({ tenantId: T, firstName: 'Anil', lastName: 'Mehta', phone: '+91 98200 11122', ownerId: rep.userId }).returning();
      const [d] = await tx
        .insert(s.deals)
        .values({
          tenantId: T,
          name: `Mehta Industries — ERP rollout (AI demo ${new Date().toISOString().slice(11, 19)})`,
          stage: 'proposal',
          currency: 'INR',
          amountMinor: toMinorUnits(800000, 'INR'),
          expectedCloseDate: '2027-01-31',
          contactId: c!.id,
          ownerId: rep.userId,
        })
        .returning();
      const [call] = await tx
        .insert(s.calls)
        .values({
          tenantId: T,
          provider: 'mock',
          providerCallId: `demo-sug-${Date.now()}`,
          direction: 'outbound',
          userId: rep.userId,
          leadId: d!.id,
          contactId: c!.id,
          fromNumber: '+918047180000',
          toNumber: '+919820011122',
          status: 'completed',
          startedAt: new Date(),
          endedAt: new Date(),
          durationSec: 140,
          talkTimeSec: 132,
          transcript: TRANSCRIPT,
          transcriptStatus: 'done',
          transcriptProvider: 'demo',
          transcriptSegments: TRANSCRIPT.split('\n').map((line, i) => ({
            speaker: line.startsWith('Agent') ? ('agent' as const) : ('customer' as const),
            startMs: i * 6000,
            endMs: i * 6000 + 5000,
            text: line.replace(/^(Agent|Customer): /, ''),
            confidence: null,
          })),
        })
        .returning();
      return { dealId: d!.id, callId: call!.id, rep: rep.userId };
    }),
  );

  const mockCreate = async () =>
    ({
      id: 'msg_demo',
      type: 'message',
      role: 'assistant',
      model: 'mock-demo-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          id: 'tu_demo',
          name: 'propose_field_changes',
          input: {
            suggestions: [
              { target: 'deal', field: 'close_date', value: '2026-12-15', due_date: null, evidence_quote: "Let's close this by 15 December", confidence: 0.9 },
              { target: 'deal', field: 'amount', value: '1200000', due_date: null, evidence_quote: 'budget is around 12 lakh', confidence: 0.75 },
            ],
          },
        },
      ],
    }) as unknown as import('@anthropic-ai/sdk').default.Message;

  const result = await runWithSystemContext(T, () =>
    runSuggestionsForCall(T, ids.callId, MOCK ? { extract: (input) => extractSuggestions(input, { create: mockCreate }) } : {}),
  );
  const rows = await runWithSystemContext(T, () =>
    tenantTransaction((tx) =>
      tx
        .select({ field: s.aiSuggestions.field, current: s.aiSuggestions.currentValueAtSuggestion, suggested: s.aiSuggestions.suggestedValue, status: s.aiSuggestions.status, evidence: s.aiSuggestions.evidenceQuote })
        .from(s.aiSuggestions)
        .where(and(eq(s.aiSuggestions.tenantId, T), eq(s.aiSuggestions.entityId, ids.dealId))),
    ),
  );

  console.log(`\n${MOCK ? 'MOCK model' : 'Claude'} run: ${JSON.stringify(result)}`);
  console.table(rows.map((r) => ({ ...r, current: JSON.stringify(r.current), suggested: JSON.stringify(r.suggested) })));
  console.log(`\nDeal: /dashboard/deals/${ids.dealId}  (owner ${ids.rep})`);
  console.log('Open it as that user, or as a manager/owner, to see the "AI suggestions" card and /dashboard/suggestions.');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('seed fatal:', err);
  process.exit(1);
});
