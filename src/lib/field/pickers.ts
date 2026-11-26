import 'server-only';

import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';

import { companies, contacts, deals } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { ownerOrUnassignedRestriction } from '@/lib/personas';

import { asActor, isUuid } from './internal';
import { toPickerCompany, type PickerChoice, type PickerCompany, type PickerKind, type PickerResponse } from './picker-link';
import type { FieldActor } from './types';

/**
 * Options for the meeting form's deal / company / contact pickers: up to 20
 * records the actor can see, most recently updated first, filtered by `q` and,
 * for deals and contacts, by `companyId`. Visibility is the CRM's own rule
 * (ownerOrUnassignedRestriction, same as the list pages and /api/search): reps
 * see records they own plus unassigned ones; managers and admins see the tenant.
 */

export const PICKER_LIMIT = 20;

export type PickerQuery = { kind: PickerKind; q?: string; companyId?: string | null };

const pattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

const companySiteCols = (c: typeof companies) => ({
  id: c.id,
  name: c.name,
  address: c.address,
  city: c.city,
  state: c.state,
  postalCode: c.postalCode,
  lat: c.lat,
  lng: c.lng,
  geocodeStatus: c.geocodeStatus,
});

/** A left-joined company (drizzle gives null when the join found nothing). */
const companyOf = (r: Parameters<typeof toPickerCompany>[0] | null): PickerCompany | null => (r ? toPickerCompany(r) : null);

const contactName = (first: string | null, last: string | null, email: string | null) =>
  [first, last].filter(Boolean).join(' ').trim() || email || 'Unnamed contact';

export function listPickerOptions(actor: FieldActor, query: PickerQuery): Promise<PickerResponse> {
  return asActor(actor, async () => {
    const q = (query.q ?? '').trim().slice(0, 100);
    const companyId = query.companyId && isUuid(query.companyId) ? query.companyId : null;
    const mine = ownerOrUnassignedRestriction(actor.role, actor.userId);
    const t = actor.tenantId;

    const items = await tenantTransaction(async (tx): Promise<PickerChoice[]> => {
      if (query.kind === 'company') {
        const conds: SQL[] = [eq(companies.tenantId, t), isNull(companies.deletedAt), isNull(companies.mergedIntoId)];
        if (mine) conds.push(or(eq(companies.ownerId, mine), isNull(companies.ownerId))!);
        if (q) conds.push(or(ilike(companies.name, pattern(q)), ilike(companies.domain, pattern(q)))!);
        const rows = await tx
          .select(companySiteCols(companies))
          .from(companies)
          .where(and(...conds))
          .orderBy(desc(companies.updatedAt), desc(companies.id))
          .limit(PICKER_LIMIT);
        return rows.map((r) => {
          const c = toPickerCompany(r);
          return { id: c.id, label: c.name, sublabel: c.city, companyId: c.id, company: c };
        });
      }

      if (query.kind === 'contact') {
        const conds: SQL[] = [eq(contacts.tenantId, t), isNull(contacts.deletedAt), isNull(contacts.mergedIntoId)];
        if (mine) conds.push(or(eq(contacts.ownerId, mine), isNull(contacts.ownerId))!);
        if (companyId) conds.push(eq(contacts.companyId, companyId));
        if (q) {
          const p = pattern(q);
          conds.push(
            or(
              ilike(contacts.firstName, p),
              ilike(contacts.lastName, p),
              ilike(contacts.email, p),
              ilike(sql`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`, p),
            )!,
          );
        }
        const rows = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            companyId: contacts.companyId,
            company: companySiteCols(companies),
          })
          .from(contacts)
          .leftJoin(companies, and(eq(companies.id, contacts.companyId), eq(companies.tenantId, t)))
          .where(and(...conds))
          .orderBy(desc(contacts.updatedAt), desc(contacts.id))
          .limit(PICKER_LIMIT);
        return rows.map((r) => {
          const company = companyOf(r.company);
          return {
            id: r.id,
            label: contactName(r.firstName, r.lastName, r.email),
            sublabel: company?.name ?? r.email ?? null,
            companyId: r.companyId,
            company,
          };
        });
      }

      const conds: SQL[] = [eq(deals.tenantId, t), isNull(deals.deletedAt)];
      if (mine) conds.push(or(eq(deals.ownerId, mine), isNull(deals.ownerId))!);
      if (companyId) conds.push(eq(deals.companyId, companyId));
      if (q) conds.push(ilike(deals.name, pattern(q)));
      const rows = await tx
        .select({
          id: deals.id,
          name: deals.name,
          amountMinor: deals.amountMinor,
          currency: deals.currency,
          stage: deals.stage,
          companyId: deals.companyId,
          company: companySiteCols(companies),
          contactId: contacts.id,
          contactFirst: contacts.firstName,
          contactLast: contacts.lastName,
          contactEmail: contacts.email,
          contactCompanyId: contacts.companyId,
        })
        .from(deals)
        .leftJoin(companies, and(eq(companies.id, deals.companyId), eq(companies.tenantId, t)))
        .leftJoin(contacts, and(eq(contacts.id, deals.contactId), eq(contacts.tenantId, t), isNull(contacts.deletedAt)))
        .where(and(...conds))
        .orderBy(desc(deals.updatedAt), desc(deals.id))
        .limit(PICKER_LIMIT);
      return rows.map((r) => {
        const company = companyOf(r.company);
        const contact: PickerChoice | null = r.contactId
          ? {
              id: r.contactId,
              label: contactName(r.contactFirst, r.contactLast, r.contactEmail),
              sublabel: company?.name ?? null,
              companyId: r.contactCompanyId,
              company: r.contactCompanyId === company?.id ? company : null,
            }
          : null;
        return {
          id: r.id,
          label: r.name,
          sublabel: `${formatCurrency(r.amountMinor, r.currency)} · ${DEAL_STAGE_LABELS[r.stage]}`,
          companyId: r.companyId,
          company,
          contact,
        };
      });
    });
    return { items };
  });
}
