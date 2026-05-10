import 'server-only';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  type EmbeddedEntityType,
  companies,
  contacts,
  deals,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';

import { semanticSearch, type SearchHit } from './search';

/**
 * Copilot orchestration: retrieval pipeline + prompt assembly. Kept on the
 * server for two reasons:
 *   1. The retrieval helpers run inside `tenantTransaction` — RLS-scoped
 *      reads only work behind a tenant context.
 *   2. The system prompt names the active tenant explicitly so the model
 *      "knows" the bounds of the data it just received. We don't expose
 *      that prompt string to the client.
 */

export type CopilotMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type RetrievedRecord = {
  entityType: EmbeddedEntityType;
  entityId: string;
  /** Compact one-line label for the Copilot UI to render. */
  label: string;
  /** Distance from the user's query (cosine, lower is closer). */
  distance: number;
};

const SYSTEM_PROMPT_BASE = `You are an AI copilot embedded in a multi-tenant CRM. You help the user understand their pipeline, identify deals at risk, surface follow-ups, and answer questions about contacts and companies — strictly using the records provided in the "Retrieved CRM context" block.

Rules:
- ONLY use the records in the retrieved context. Never invent deals, companies, contacts, amounts, stages, or dates.
- If the retrieved context is empty or doesn't cover the question, say you can't see relevant records and suggest a more specific query.
- When you reference a record, include the record's name in plain text (no link syntax). The UI will render references separately.
- Be concise. Bullet points for lists; 1–3 sentences for analysis. No fluff, no apologies, no preamble.
- Never reference data from other tenants. The retrieved context is the only ground truth.`;

export function buildSystemPrompt(args: {
  tenantId: string;
  retrieved: SearchHit[];
}): string {
  const { tenantId, retrieved } = args;
  if (retrieved.length === 0) {
    return `${SYSTEM_PROMPT_BASE}

Active tenant: ${tenantId}
Retrieved CRM context: (none)`;
  }
  const blocks = retrieved.map((hit, i) => {
    return `Record #${i + 1} — type=${hit.entityType} id=${hit.entityId} distance=${hit.distance.toFixed(3)}
${hit.content}`;
  });
  return `${SYSTEM_PROMPT_BASE}

Active tenant: ${tenantId}
Retrieved CRM context:
${blocks.join('\n\n---\n\n')}`;
}

/**
 * Hydrate semantic-search hits into UI-friendly labels. We need this
 * because the embedded `content` field carries multi-line summaries; the
 * UI wants a one-liner per reference (deal name + stage, contact name +
 * email, …).
 */
export async function hydrateReferences(
  tenantId: string,
  hits: SearchHit[],
): Promise<RetrievedRecord[]> {
  if (hits.length === 0) return [];

  const dealIds = hits.filter((h) => h.entityType === 'deal').map((h) => h.entityId);
  const companyIds = hits
    .filter((h) => h.entityType === 'company')
    .map((h) => h.entityId);
  const contactIds = hits
    .filter((h) => h.entityType === 'contact')
    .map((h) => h.entityId);

  const labels = new Map<string, string>();

  await tenantTransaction(async (tx) => {
    if (dealIds.length) {
      const rows = await tx
        .select({
          id: deals.id,
          name: deals.name,
          stage: deals.stage,
          amountMinor: deals.amountMinor,
          currency: deals.currency,
        })
        .from(deals)
        .where(
          and(
            eq(deals.tenantId, tenantId),
            inArray(deals.id, dealIds),
            isNull(deals.deletedAt),
          ),
        );
      for (const r of rows) {
        labels.set(
          `deal:${r.id}`,
          `${r.name} — ${DEAL_STAGE_LABELS[r.stage] ?? r.stage} (${formatCurrency(r.amountMinor, r.currency)})`,
        );
      }
    }
    if (companyIds.length) {
      const rows = await tx
        .select({ id: companies.id, name: companies.name, domain: companies.domain })
        .from(companies)
        .where(
          and(
            eq(companies.tenantId, tenantId),
            inArray(companies.id, companyIds),
            isNull(companies.deletedAt),
          ),
        );
      for (const r of rows) {
        labels.set(
          `company:${r.id}`,
          r.domain ? `${r.name} (${r.domain})` : r.name,
        );
      }
    }
    if (contactIds.length) {
      const rows = await tx
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            inArray(contacts.id, contactIds),
            isNull(contacts.deletedAt),
          ),
        );
      for (const r of rows) {
        const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
        const headline = name && r.email ? `${name} <${r.email}>` : name || r.email || 'Contact';
        labels.set(`contact:${r.id}`, headline);
      }
    }
  });

  return hits.map((h) => ({
    entityType: h.entityType,
    entityId: h.entityId,
    label: labels.get(`${h.entityType}:${h.entityId}`) ?? '(record no longer in this tenant)',
    distance: h.distance,
  }));
}

/**
 * Run retrieval for the latest user message and return both the
 * hydrated references (for the UI) and the assembled OpenAI messages
 * (for the streaming completion).
 */
export async function prepareCopilotPrompt(args: {
  tenantId: string;
  actorUserId: string | null;
  history: CopilotMessage[];
  /**
   * The latest user message — separated from `history` so we can use it
   * as the retrieval query and still include prior turns in the LLM
   * prompt.
   */
  question: string;
  /** Top-K. Default 6. */
  k?: number;
}): Promise<{
  references: RetrievedRecord[];
  messages: ChatCompletionMessageParam[];
}> {
  const hits = await semanticSearch({
    tenantId: args.tenantId,
    actorUserId: args.actorUserId,
    query: args.question,
    limit: args.k ?? 6,
  });
  const references = await hydrateReferences(args.tenantId, hits);

  const system = buildSystemPrompt({ tenantId: args.tenantId, retrieved: hits });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...args.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: args.question },
  ];

  return { references, messages };
}
