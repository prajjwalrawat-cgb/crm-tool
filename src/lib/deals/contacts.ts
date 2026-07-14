import 'server-only';

import { and, asc, desc, eq } from 'drizzle-orm';

import { contacts, dealContacts } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type { DealContactRow } from './contact-shared';

// Re-export the client-safe helpers so existing server-side imports of
// `@/lib/deals/contacts` keep working.
export {
  DEAL_CONTACT_ROLE_LABELS,
  dealContactName,
  type DealContactRow,
} from './contact-shared';

/**
 * Stakeholders linked to a deal, primary first, then most recently added.
 * Joined against `contacts` so the card can render name/email/phone/title
 * without a second round-trip per row.
 */
export async function listDealContacts(
  tenantId: string,
  dealId: string,
): Promise<DealContactRow[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        id: dealContacts.id,
        contactId: dealContacts.contactId,
        role: dealContacts.role,
        isPrimary: dealContacts.isPrimary,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        title: contacts.title,
      })
      .from(dealContacts)
      .innerJoin(contacts, eq(dealContacts.contactId, contacts.id))
      .where(
        and(
          eq(dealContacts.tenantId, tenantId),
          eq(dealContacts.dealId, dealId),
        ),
      )
      .orderBy(desc(dealContacts.isPrimary), asc(dealContacts.createdAt)),
  );
}

