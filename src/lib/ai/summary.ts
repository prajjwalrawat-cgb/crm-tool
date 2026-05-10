import 'server-only';

import { and, eq } from 'drizzle-orm';

import { aiSummaries, type EmbeddedEntityType } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { complete } from './complete';
import { hashContent } from './embed';
import { AI_MODELS } from './openai';
import {
  buildCompanyEmbedText,
  buildContactEmbedText,
  buildDealEmbedText,
} from './text';

/**
 * Entity-summary cache. The first call generates a summary via gpt-4o-mini
 * and writes the row; subsequent calls with the same source content return
 * the cached row. Source-text drift (deal updates, new activity) flips the
 * `sourceHash` and forces regeneration on next access.
 */
export type EntitySummaryStatus = 'cached' | 'created' | 'updated';

export type EntitySummary = {
  summary: string;
  status: EntitySummaryStatus;
  generatedAt: Date;
};

const SYSTEM_PROMPT = `You are a CRM analyst assistant. Given the structured details of a single CRM record (deal, company, or contact) plus a tail of recent activity, produce a tight 2–4 sentence executive summary. Lead with the current state, then call out the most relevant signal (momentum, blocker, or open question). Do not invent facts; only summarize what is in the input. Do not speculate about people or companies you don't see in the input.`;

async function loadSourceText(
  tenantId: string,
  entityType: EmbeddedEntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'deal':
      return buildDealEmbedText(tenantId, entityId);
    case 'company':
      return buildCompanyEmbedText(tenantId, entityId);
    case 'contact':
      return buildContactEmbedText(tenantId, entityId);
  }
}

export type GenerateEntitySummaryInput = {
  tenantId: string;
  actorUserId: string | null;
  entityType: EmbeddedEntityType;
  entityId: string;
  /** Force regeneration even when cached. Defaults to false. */
  force?: boolean;
};

export async function generateEntitySummary(
  input: GenerateEntitySummaryInput,
): Promise<EntitySummary | null> {
  const sourceText = await loadSourceText(
    input.tenantId,
    input.entityType,
    input.entityId,
  );
  if (!sourceText) return null;

  const sourceHash = hashContent(sourceText);

  if (!input.force) {
    const existing = await tenantTransaction(async (tx) =>
      tx
        .select({
          summary: aiSummaries.summary,
          sourceHash: aiSummaries.sourceHash,
          generatedAt: aiSummaries.generatedAt,
        })
        .from(aiSummaries)
        .where(
          and(
            eq(aiSummaries.tenantId, input.tenantId),
            eq(aiSummaries.entityType, input.entityType),
            eq(aiSummaries.entityId, input.entityId),
          ),
        )
        .limit(1),
    );
    if (existing[0] && existing[0].sourceHash === sourceHash) {
      return {
        summary: existing[0].summary,
        status: 'cached',
        generatedAt: existing[0].generatedAt,
      };
    }
  }

  const result = await complete({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    kind: 'summary',
    model: AI_MODELS.summary,
    temperature: 0.2,
    maxTokens: 220,
    metadata: {
      entityType: input.entityType,
      entityId: input.entityId,
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this ${input.entityType}:\n\n${sourceText}`,
      },
    ],
  });

  const summary = result.content.trim();
  if (!summary) {
    throw new Error('Model returned empty summary content');
  }

  const status = await tenantTransaction(async (tx) => {
    const [row] = await tx
      .insert(aiSummaries)
      .values({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        summary,
        model: AI_MODELS.summary,
        sourceHash,
      })
      .onConflictDoUpdate({
        target: [
          aiSummaries.tenantId,
          aiSummaries.entityType,
          aiSummaries.entityId,
        ],
        set: {
          summary,
          model: AI_MODELS.summary,
          sourceHash,
          generatedAt: new Date(),
        },
      })
      .returning({
        generatedAt: aiSummaries.generatedAt,
      });
    return row?.generatedAt ?? new Date();
  });

  return {
    summary,
    status: 'created',
    generatedAt: status,
  };
}
