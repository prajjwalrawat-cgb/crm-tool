import 'server-only';

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import {
  companies,
  contacts,
  deals,
  emailMessages,
  type EmailMessage,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';

export type EmailEntityType = 'deal' | 'company' | 'contact';
export type EmailStatusFilter = 'all' | 'sent' | 'failed' | 'queued';

/**
 * Emails attached to one entity, newest first. Used by the unified
 * entity timeline. Capped to a sensible per-page limit; tenants
 * with very chatty entities can paginate later.
 */
export async function listEmailsForEntity(
  tenantId: string,
  entityType: EmailEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<EmailMessage[]> {
  const limit = options.limit ?? 100;
  return await timeQuery('email.forEntity', async () =>
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.entityType, entityType),
            eq(emailMessages.entityId, entityId),
          ),
        )
        .orderBy(desc(emailMessages.createdAt))
        .limit(limit),
    ),
  );
}

export type GlobalEmailRow = EmailMessage & {
  entityLabel: string | null;
};

/**
 * All emails in this tenant, newest first, with the linked entity's
 * display name joined in. Powers the centralized
 * `/dashboard/email` page. Optional status filter narrows to one
 * delivery state; `search` matches subject + recipient prefix.
 */
export async function listAllEmails(
  tenantId: string,
  options: {
    limit?: number;
    status?: EmailStatusFilter;
    search?: string;
  } = {},
): Promise<GlobalEmailRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const status = options.status ?? 'all';
  const trimmed = options.search?.trim() ?? '';

  return await timeQuery('email.listAll', async () =>
    tenantTransaction(async (tx) => {
      const conditions: SQL[] = [eq(emailMessages.tenantId, tenantId)];

      if (status === 'sent') {
        conditions.push(inArray(emailMessages.status, ['sent', 'delivered']));
      } else if (status === 'failed') {
        conditions.push(eq(emailMessages.status, 'failed'));
      } else if (status === 'queued') {
        conditions.push(inArray(emailMessages.status, ['queued', 'sending']));
      }

      if (trimmed) {
        // ILIKE on subject + a JSONB-text contains on recipients. Cheap
        // for tens of thousands of rows; if traffic grows, this graduates
        // to pg_trgm + GIN.
        const needle = `%${trimmed.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const searchClause = or(
          sql`${emailMessages.subject} ILIKE ${needle}`,
          sql`array_to_string(${emailMessages.toRecipients}, ',') ILIKE ${needle}`,
        );
        if (searchClause) conditions.push(searchClause);
      }

      const rows = await tx
        .select()
        .from(emailMessages)
        .where(and(...conditions))
        .orderBy(desc(emailMessages.createdAt))
        .limit(limit);

      // Resolve a display name per linked entity in three small queries —
      // simpler and faster than a polymorphic JOIN. Tenants with the
      // index on (tenant_id, entity_type, entity_id) hit these cheaply.
      const byKind: Record<EmailEntityType, Set<string>> = {
        deal: new Set(),
        company: new Set(),
        contact: new Set(),
      };
      for (const r of rows) {
        if (r.entityType && r.entityId && r.entityType in byKind) {
          byKind[r.entityType as EmailEntityType].add(r.entityId);
        }
      }

      const labels = new Map<string, string>();
      if (byKind.deal.size > 0) {
        const dealRows = await tx
          .select({ id: deals.id, label: deals.name })
          .from(deals)
          .where(
            and(
              eq(deals.tenantId, tenantId),
              inArray(deals.id, Array.from(byKind.deal)),
            ),
          );
        for (const d of dealRows) labels.set(`deal:${d.id}`, d.label);
      }
      if (byKind.company.size > 0) {
        const coRows = await tx
          .select({ id: companies.id, label: companies.name })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, tenantId),
              inArray(companies.id, Array.from(byKind.company)),
            ),
          );
        for (const c of coRows) labels.set(`company:${c.id}`, c.label);
      }
      if (byKind.contact.size > 0) {
        const ctRows = await tx
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
              inArray(contacts.id, Array.from(byKind.contact)),
            ),
          );
        for (const c of ctRows) {
          const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
          labels.set(
            `contact:${c.id}`,
            parts.length > 0 ? parts.join(' ') : c.email ?? '(unnamed)',
          );
        }
      }

      return rows.map((r) => ({
        ...r,
        entityLabel:
          r.entityType && r.entityId
            ? labels.get(`${r.entityType}:${r.entityId}`) ?? null
            : null,
      }));
    }),
  );
}
