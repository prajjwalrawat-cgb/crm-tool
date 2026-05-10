import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import {
  type Company,
  type Contact,
  type Deal,
  activityLogs,
  companies,
  contacts,
  deals,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';

/**
 * Convert a CRM row into the canonical text we embed and feed to the LLM.
 *
 * Embeddings are only as useful as the text behind them — a deal whose
 * source text is just `name` will only ever match by name. We include
 * stage, owner, related company/contact, currency, expected close, and
 * recent activity so semantic retrieval picks up queries like "deals
 * stuck in negotiation" or "deals with Acme that haven't moved".
 *
 * Each builder runs inside the caller's tenant context — the joins below
 * are RLS-scoped, so a deal's company/contact lookups can't bleed across
 * tenants even if the row itself somehow crossed boundaries.
 */

const ACTIVITY_TAIL = 8;

/* -------- Deal -------- */

type DealJoined = {
  deal: Deal;
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

async function loadDealWithRelations(
  tenantId: string,
  dealId: string,
): Promise<DealJoined | null> {
  return await tenantTransaction(async (tx) => {
    const rows = await tx
      .select({
        deal: deals,
        companyName: companies.name,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        contactEmail: contacts.email,
      })
      .from(deals)
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.id, dealId),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const nameParts = [row.contactFirstName, row.contactLastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      deal: row.deal,
      companyName: row.companyName ?? null,
      contactName: nameParts.length ? nameParts : null,
      contactEmail: row.contactEmail,
    };
  });
}

async function loadEntityActivityTail(
  tenantId: string,
  entityType: 'deal' | 'company' | 'contact',
  entityId: string,
): Promise<string[]> {
  return await tenantTransaction(async (tx) => {
    const rows = await tx
      .select({
        action: activityLogs.action,
        metadata: activityLogs.metadata,
        createdAt: activityLogs.createdAt,
      })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityType, entityType),
          eq(activityLogs.entityId, entityId),
        ),
      )
      .limit(ACTIVITY_TAIL);

    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const message = typeof meta.message === 'string' ? meta.message : '';
      const summary = message
        ? `: ${message}`
        : Object.keys(meta).length
          ? `: ${JSON.stringify(meta)}`
          : '';
      return `- [${r.createdAt.toISOString().slice(0, 10)}] ${r.action}${summary}`;
    });
  });
}

export async function buildDealEmbedText(
  tenantId: string,
  dealId: string,
): Promise<string | null> {
  const joined = await loadDealWithRelations(tenantId, dealId);
  if (!joined) return null;
  const { deal, companyName, contactName, contactEmail } = joined;

  const lines: string[] = [
    `Deal: ${deal.name}`,
    `Stage: ${DEAL_STAGE_LABELS[deal.stage] ?? deal.stage}`,
    `Amount: ${formatCurrency(deal.amountMinor, deal.currency)}`,
  ];
  if (deal.expectedCloseDate) lines.push(`Expected close: ${deal.expectedCloseDate}`);
  if (deal.closedAt) lines.push(`Closed: ${deal.closedAt.toISOString().slice(0, 10)}`);
  if (companyName) lines.push(`Company: ${companyName}`);
  if (contactName || contactEmail) {
    lines.push(`Contact: ${[contactName, contactEmail].filter(Boolean).join(' ')}`);
  }
  lines.push(`Created: ${deal.createdAt.toISOString().slice(0, 10)}`);
  lines.push(`Updated: ${deal.updatedAt.toISOString().slice(0, 10)}`);

  const activity = await loadEntityActivityTail(tenantId, 'deal', deal.id);
  if (activity.length) {
    lines.push('Recent activity:');
    lines.push(...activity);
  }
  return lines.join('\n');
}

/* -------- Company -------- */

export async function buildCompanyEmbedText(
  tenantId: string,
  companyId: string,
): Promise<string | null> {
  const company = await tenantTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, tenantId),
          eq(companies.id, companyId),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!company) return null;

  const lines: string[] = [
    `Company: ${company.name}`,
  ];
  if (company.domain) lines.push(`Domain: ${company.domain}`);
  if (company.industry) lines.push(`Industry: ${company.industry}`);
  lines.push(`Created: ${company.createdAt.toISOString().slice(0, 10)}`);

  const activity = await loadEntityActivityTail(tenantId, 'company', company.id);
  if (activity.length) {
    lines.push('Recent activity:');
    lines.push(...activity);
  }
  return lines.join('\n');
}

/* -------- Contact -------- */

export async function buildContactEmbedText(
  tenantId: string,
  contactId: string,
): Promise<string | null> {
  const joined = await tenantTransaction(async (tx) => {
    const rows = await tx
      .select({ contact: contacts, companyName: companies.name })
      .from(contacts)
      .leftJoin(companies, eq(contacts.companyId, companies.id))
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, contactId),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
  if (!joined) return null;
  const { contact, companyName } = joined;

  const displayName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(' ')
    .trim() || contact.email || contact.id;
  const lines: string[] = [`Contact: ${displayName}`];
  if (contact.title) lines.push(`Title: ${contact.title}`);
  if (contact.email) lines.push(`Email: ${contact.email}`);
  if (contact.phone) lines.push(`Phone: ${contact.phone}`);
  if (companyName) lines.push(`Company: ${companyName}`);
  lines.push(`Created: ${contact.createdAt.toISOString().slice(0, 10)}`);

  const activity = await loadEntityActivityTail(tenantId, 'contact', contact.id);
  if (activity.length) {
    lines.push('Recent activity:');
    lines.push(...activity);
  }
  return lines.join('\n');
}

/* -------- Compact one-line label (used in retrieval prompt context) -------- */

export function dealHeadline(deal: Pick<Deal, 'name' | 'stage' | 'amountMinor' | 'currency'>): string {
  return `${deal.name} — ${DEAL_STAGE_LABELS[deal.stage] ?? deal.stage} (${formatCurrency(deal.amountMinor, deal.currency)})`;
}

export function companyHeadline(company: Pick<Company, 'name' | 'domain'>): string {
  return company.domain ? `${company.name} (${company.domain})` : company.name;
}

export function contactHeadline(contact: Pick<Contact, 'firstName' | 'lastName' | 'email'>): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  if (name && contact.email) return `${name} <${contact.email}>`;
  return name || contact.email || 'Unnamed contact';
}
