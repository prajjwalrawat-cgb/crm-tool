import 'server-only';

import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  type EmbeddedEntityType,
  embeddings,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { recordAiInvocation } from './audit';
import { aiLive, aiModeLabel } from './config';
import { mockEmbedding, approxTokens } from './mock';
import { AI_MODELS, getOpenAI } from './openai';

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

type EmbedInput = {
  tenantId: string;
  actorUserId: string | null;
  content: string;
};

/**
 * Generate a single OpenAI embedding and audit the call. Throws on API
 * failure so the caller (the embedding workflow) lets Inngest retry.
 *
 * When AI is not in `live` mode the function returns a deterministic
 * 1536-d mock vector and records an audit row with status=`skipped` so
 * the cost/usage histories stay queryable across mode flips.
 */
export async function generateEmbedding(input: EmbedInput): Promise<number[]> {
  const startedAt = Date.now();
  const mode = aiModeLabel();

  if (!aiLive()) {
    const vector = mockEmbedding(input.content);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'embed',
      model: AI_MODELS.embed,
      promptTokens: approxTokens(input.content),
      totalTokens: approxTokens(input.content),
      latencyMs: Date.now() - startedAt,
      status: 'skipped',
      metadata: { mode, mock: true, contentChars: input.content.length },
    });
    return vector;
  }

  try {
    const response = await getOpenAI().embeddings.create({
      model: AI_MODELS.embed,
      input: input.content,
      // OpenAI uses `user` for downstream abuse correlation. We pass the
      // tenant id so anomalies surface per-tenant, not per-actor.
      user: input.tenantId,
    });
    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI returned no embedding vector');
    }
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'embed',
      model: AI_MODELS.embed,
      promptTokens: response.usage?.prompt_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      latencyMs: Date.now() - startedAt,
      status: 'success',
      metadata: { mode },
    });
    return embedding;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'embed',
      model: AI_MODELS.embed,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: message,
      metadata: { mode },
    });
    throw err;
  }
}

type UpsertInput = {
  tenantId: string;
  entityType: EmbeddedEntityType;
  entityId: string;
  content: string;
  actorUserId: string | null;
};

/**
 * Upsert an entity's embedding. Skips the OpenAI call entirely when the
 * `content_hash` matches what we already stored — keeps token cost flat
 * across no-op updates (e.g. a deal stage change that doesn't affect the
 * embedded text).
 *
 * Returns `'cached'` when the existing row was reusable, `'created'` for
 * a fresh insert, or `'updated'` when content drifted.
 */
export async function upsertEntityEmbedding(
  input: UpsertInput,
): Promise<'cached' | 'created' | 'updated'> {
  const contentHash = hashContent(input.content);

  const existing = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: embeddings.id,
        contentHash: embeddings.contentHash,
      })
      .from(embeddings)
      .where(
        and(
          eq(embeddings.tenantId, input.tenantId),
          eq(embeddings.entityType, input.entityType),
          eq(embeddings.entityId, input.entityId),
        ),
      )
      .limit(1),
  );

  if (existing[0]?.contentHash === contentHash) {
    return 'cached';
  }

  const vector = await generateEmbedding({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    content: input.content,
  });

  await tenantTransaction(async (tx) => {
    await tx
      .insert(embeddings)
      .values({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        content: input.content,
        embedding: vector,
        model: AI_MODELS.embed,
        contentHash,
      })
      .onConflictDoUpdate({
        target: [embeddings.tenantId, embeddings.entityType, embeddings.entityId],
        set: {
          content: input.content,
          embedding: vector,
          contentHash,
          model: AI_MODELS.embed,
        },
      });
  });

  return existing[0] ? 'updated' : 'created';
}

/**
 * Delete an entity's embedding when the row is hard-deleted. Soft delete
 * leaves the embedding in place so semantic search can still find recently
 * archived records (matches the recently-deleted page's intent).
 */
export async function deleteEntityEmbedding(input: {
  tenantId: string;
  entityType: EmbeddedEntityType;
  entityId: string;
}): Promise<void> {
  await tenantTransaction(async (tx) => {
    await tx
      .delete(embeddings)
      .where(
        and(
          eq(embeddings.tenantId, input.tenantId),
          eq(embeddings.entityType, input.entityType),
          eq(embeddings.entityId, input.entityId),
        ),
      );
  });
}
