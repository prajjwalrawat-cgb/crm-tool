import 'server-only';

import {
  aiInvocations,
  type AiInvocationKind,
  type AiInvocationStatus,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export type AuditInput = {
  tenantId: string;
  actorUserId: string | null;
  kind: AiInvocationKind;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  latencyMs?: number | null;
  status: AiInvocationStatus;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Persist a single AI call to `ai_invocations`. Every code path that talks
 * to OpenAI funnels through here so token cost, error rates, and per-tenant
 * usage stay queryable from one table.
 *
 * Called from inside an active tenant context — RLS on ai_invocations
 * requires `app.tenant_id` to match.
 */
export async function recordAiInvocation(input: AuditInput): Promise<void> {
  await tenantTransaction(async (tx) => {
    await tx.insert(aiInvocations).values({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      model: input.model,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      latencyMs: input.latencyMs ?? null,
      status: input.status,
      error: input.error ?? null,
      metadata: input.metadata ?? {},
    });
  });
}
