import 'server-only';

import { sql } from 'drizzle-orm';

import {
  type EmbeddedEntityType,
  EMBEDDED_ENTITY_TYPES,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { recordAiInvocation } from './audit';
import { generateEmbedding } from './embed';
import { AI_MODELS, EMBEDDING_DIMENSIONS } from './openai';

/**
 * Tenant-scoped semantic retrieval.
 *
 * Two layers of isolation guard against cross-tenant leakage:
 *   1. The query runs inside `tenantTransaction`, which sets
 *      `app.tenant_id`. RLS on `embeddings` already restricts SELECT to
 *      the active tenant — even a buggy query would return zero foreign
 *      rows.
 *   2. We *also* push `tenant_id = $1` into the WHERE clause as a belt
 *      -and-suspenders constraint, visible to anyone reading the SQL.
 *
 * Distance is `<=>` (cosine distance, returned by pgvector). Lower is
 * closer, so we ORDER BY ASC and LIMIT.
 */

export type SearchHit = {
  entityType: EmbeddedEntityType;
  entityId: string;
  content: string;
  /** Cosine distance (0 = identical, 2 = opposite). Lower is better. */
  distance: number;
};

export type SearchInput = {
  tenantId: string;
  actorUserId: string | null;
  query: string;
  /** Restrict to one or more entity types. Default = all. */
  entityTypes?: EmbeddedEntityType[];
  /** Top-K. Default 6 — small enough to fit in a copilot prompt. */
  limit?: number;
};

const DEFAULT_LIMIT = 6;
/**
 * Cosine distance ceiling. Anything above this we treat as "no real match"
 * — tuned at the high end since `text-embedding-3-small` cosine distances
 * for unrelated CRM strings tend to sit around 1.0–1.4.
 */
const MAX_DISTANCE = 1.4;

export async function semanticSearch(input: SearchInput): Promise<SearchHit[]> {
  const startedAt = Date.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const types = input.entityTypes ?? Array.from(EMBEDDED_ENTITY_TYPES);

  // Embed the query as its own audited call so search costs are visible
  // alongside chat/summary in `ai_invocations`.
  const queryVector = await generateEmbedding({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    content: input.query,
  });
  if (queryVector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dim mismatch: got ${queryVector.length}, expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }

  // pgvector accepts the literal string form `'[0.1,0.2,…]'::vector`. We
  // bind the vector that way to avoid driver-level array gymnastics.
  const vectorLiteral = `[${queryVector.join(',')}]`;

  // Drizzle's `sql\`\`` template expands a JS array `${arr}` into a
  // comma-separated tuple of bind parameters — `($3, $4, $5)` — which
  // is wrong for `ANY()`. `ANY()` wants a single array argument. We
  // build the Postgres array literal as a string so it binds as one
  // text parameter and cast to text[].
  const typesLiteral = `{${types
    .map((t) => t.replace(/(["\\,])/g, '\\$1'))
    .join(',')}}`;

  try {
    const rows = await tenantTransaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          entity_type AS "entityType",
          entity_id AS "entityId",
          content,
          embedding <=> ${vectorLiteral}::vector AS distance
        FROM embeddings
        WHERE tenant_id = ${input.tenantId}::uuid
          AND entity_type = ANY(${typesLiteral}::text[])
          AND embedding <=> ${vectorLiteral}::vector < ${MAX_DISTANCE}
        ORDER BY embedding <=> ${vectorLiteral}::vector ASC
        LIMIT ${limit}
      `);
      // postgres-js returns the raw row array on .execute()
      return result as unknown as Array<{
        entityType: EmbeddedEntityType;
        entityId: string;
        content: string;
        distance: number | string;
      }>;
    });

    const hits: SearchHit[] = rows.map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
      content: r.content,
      distance:
        typeof r.distance === 'string' ? Number.parseFloat(r.distance) : r.distance,
    }));

    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'search',
      model: AI_MODELS.embed,
      latencyMs: Date.now() - startedAt,
      status: 'success',
      metadata: {
        query: input.query,
        hits: hits.length,
        types,
      },
    });
    return hits;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'search',
      model: AI_MODELS.embed,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: message,
      metadata: { query: input.query, types },
    });
    throw err;
  }
}
