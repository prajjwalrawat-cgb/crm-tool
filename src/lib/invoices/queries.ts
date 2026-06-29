import 'server-only';

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import {
  type InvoiceParty,
  type InvoiceSeller,
  type ProformaInvoice,
  type ProformaInvoiceItem,
  proformaInvoiceItems,
  proformaInvoices,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { computeTotals, rupeesToMinor } from './money';
import type { CreateInvoiceInput } from './schema';

/** Indian financial year (Apr–Mar) label + bounds for a yyyy-mm-dd date. */
function financialYear(isoDate: string): {
  label: string;
  start: string;
  end: string;
} {
  const [y, m] = isoDate.split('-').map((n) => Number(n));
  const year = y!;
  const startYear = (m ?? 1) >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  const two = (n: number) => String(n).slice(-2).padStart(2, '0');
  return {
    label: `${two(startYear)}-${two(endYear)}`,
    start: `${startYear}-04-01`,
    end: `${endYear}-03-31`,
  };
}

/**
 * Next PI number for a tenant within the invoice's financial year, e.g.
 * `PI/25-26/001`. Derived from the HIGHEST existing sequence in that FY (the
 * numeric suffix), not the row count — so deleting a middle invoice can't make
 * the next number collide with an existing one. A unique index on
 * (tenant_id, pi_number) guards against a concurrent collision; the caller
 * retries on violation.
 */
async function nextPiNumber(
  tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0],
  tenantId: string,
  piDate: string,
): Promise<string> {
  const fy = financialYear(piDate);
  // Parse the trailing `/<NNN>` segment as an int; ignore any odd legacy values.
  const [{ maxSeq }] = await tx
    .select({
      maxSeq: sql<number>`coalesce(max(case when split_part(${proformaInvoices.piNumber}, '/', 3) ~ '^[0-9]+$' then split_part(${proformaInvoices.piNumber}, '/', 3)::int else 0 end), 0)`,
    })
    .from(proformaInvoices)
    .where(
      and(
        eq(proformaInvoices.tenantId, tenantId),
        gte(proformaInvoices.piDate, fy.start),
        lte(proformaInvoices.piDate, fy.end),
      ),
    );
  const seq = (maxSeq ?? 0) + 1;
  return `PI/${fy.label}/${String(seq).padStart(3, '0')}`;
}

export type CreatedInvoice = { id: string; piNumber: string };

/**
 * Insert a PI + its line items inside a single tenant transaction (RLS
 * enforced). Totals are recomputed server-side from the validated input —
 * the client's numbers are never trusted. Retries once on a PI-number race.
 */
export async function createInvoice(
  tenantId: string,
  createdBy: string,
  input: CreateInvoiceInput,
): Promise<CreatedInvoice> {
  const totals = computeTotals(
    input.items.map((i) => ({ quantity: i.quantity, rate: i.rate })),
    input.taxRate,
    { amount: input.shippingAmount, taxRatePercent: input.shippingTaxRate },
  );

  const seller: InvoiceSeller = input.seller;
  const buyer: InvoiceParty = input.buyer;
  const consignee: InvoiceParty | null =
    input.consigneeSameAsBuyer || !input.consignee?.name
      ? null
      : input.consignee;

  const attempt = async (): Promise<CreatedInvoice> =>
    tenantTransaction(async (tx) => {
      const piNumber = await nextPiNumber(tx, tenantId, input.piDate);
      const [invoice] = await tx
        .insert(proformaInvoices)
        .values({
          tenantId,
          piNumber,
          piDate: input.piDate,
          currency: input.currency,
          seller,
          buyer,
          consignee,
          paymentTerms: input.paymentTerms ?? null,
          deliveryTerms: input.deliveryTerms ?? null,
          notes: input.notes ?? null,
          taxRate: String(input.taxRate),
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          shippingMinor: totals.shippingMinor,
          shippingTaxRate: String(input.shippingTaxRate),
          createdBy,
        })
        .returning({ id: proformaInvoices.id, piNumber: proformaInvoices.piNumber });

      const row = invoice!;
      await tx.insert(proformaInvoiceItems).values(
        input.items.map((it, idx) => ({
          tenantId,
          invoiceId: row.id,
          description: it.description,
          hsnSac: it.hsnSac ?? null,
          unit: it.unit,
          quantity: it.quantity,
          rateMinor: rupeesToMinor(it.rate),
          amountMinor: totals.amountsMinor[idx]!,
          imageUrl: it.imageUrl ?? null,
          sortOrder: idx,
        })),
      );
      return { id: row.id, piNumber: row.piNumber };
    });

  // Retry on the PI-number race: each attempt recomputes the next sequence, so
  // concurrent creates resolve to distinct sequential numbers instead of one
  // user hitting a duplicate-key error.
  const MAX_ATTEMPTS = 6;
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (err) {
      const msg = String((err as { cause?: { message?: string } })?.cause?.message ?? err);
      if (msg.includes('proforma_invoices_tenant_number_unique')) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Replace a PI's header + line items in place. Keeps the original PI number;
 * stamps `editedBy` for the audit trail (and `updatedAt` via $onUpdate).
 * Returns false if no PI matched (wrong tenant / deleted).
 */
export async function updateInvoice(
  tenantId: string,
  editedBy: string,
  id: string,
  input: CreateInvoiceInput,
): Promise<boolean> {
  const totals = computeTotals(
    input.items.map((i) => ({ quantity: i.quantity, rate: i.rate })),
    input.taxRate,
    { amount: input.shippingAmount, taxRatePercent: input.shippingTaxRate },
  );
  const consignee: InvoiceParty | null =
    input.consigneeSameAsBuyer || !input.consignee?.name ? null : input.consignee;

  return tenantTransaction(async (tx) => {
    const [updated] = await tx
      .update(proformaInvoices)
      .set({
        piDate: input.piDate,
        currency: input.currency,
        seller: input.seller,
        buyer: input.buyer,
        consignee,
        paymentTerms: input.paymentTerms ?? null,
        deliveryTerms: input.deliveryTerms ?? null,
        notes: input.notes ?? null,
        taxRate: String(input.taxRate),
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        shippingMinor: totals.shippingMinor,
        shippingTaxRate: String(input.shippingTaxRate),
        editedBy,
      })
      .where(
        and(eq(proformaInvoices.tenantId, tenantId), eq(proformaInvoices.id, id)),
      )
      .returning({ id: proformaInvoices.id });
    if (!updated) return false;

    // Replace the line items wholesale (simplest correct semantics).
    await tx
      .delete(proformaInvoiceItems)
      .where(eq(proformaInvoiceItems.invoiceId, id));
    await tx.insert(proformaInvoiceItems).values(
      input.items.map((it, idx) => ({
        tenantId,
        invoiceId: id,
        description: it.description,
        hsnSac: it.hsnSac ?? null,
        unit: it.unit,
        quantity: it.quantity,
        rateMinor: rupeesToMinor(it.rate),
        amountMinor: totals.amountsMinor[idx]!,
        imageUrl: it.imageUrl ?? null,
        sortOrder: idx,
      })),
    );
    return true;
  });
}

/** Delete a PI (line items cascade). Returns false if nothing matched. */
export async function deleteInvoice(
  tenantId: string,
  id: string,
): Promise<boolean> {
  return tenantTransaction(async (tx) => {
    const [row] = await tx
      .delete(proformaInvoices)
      .where(
        and(eq(proformaInvoices.tenantId, tenantId), eq(proformaInvoices.id, id)),
      )
      .returning({ id: proformaInvoices.id });
    return Boolean(row);
  });
}

export type InvoiceListRow = {
  id: string;
  piNumber: string;
  piDate: string;
  buyerName: string;
  totalMinor: number;
  currency: string;
  status: string;
  createdAt: Date;
};

/** Offset-paginated, newest first, with optional search. */
export async function listInvoices(
  tenantId: string,
  opts: {
    page: number;
    size: number;
    search?: string;
    /** When set, only return PIs created by this user (member scoping). */
    restrictToCreatedBy?: string;
  },
): Promise<{ rows: InvoiceListRow[]; total: number }> {
  const page = Math.max(1, opts.page);
  const offset = (page - 1) * opts.size;

  // Match on PI number or buyer name (case-insensitive).
  const filters = [eq(proformaInvoices.tenantId, tenantId)];
  if (opts.restrictToCreatedBy) {
    filters.push(eq(proformaInvoices.createdBy, opts.restrictToCreatedBy));
  }
  if (opts.search) {
    const like = `%${opts.search}%`;
    filters.push(
      sql`(${proformaInvoices.piNumber} ILIKE ${like} OR ${proformaInvoices.buyer}->>'name' ILIKE ${like})`,
    );
  }
  const where = and(...filters);

  return tenantTransaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(proformaInvoices)
      .where(where);

    const rows = await tx
      .select({
        id: proformaInvoices.id,
        piNumber: proformaInvoices.piNumber,
        piDate: proformaInvoices.piDate,
        buyerName: sql<string>`${proformaInvoices.buyer}->>'name'`,
        totalMinor: proformaInvoices.totalMinor,
        currency: proformaInvoices.currency,
        status: proformaInvoices.status,
        createdAt: proformaInvoices.createdAt,
      })
      .from(proformaInvoices)
      .where(where)
      .orderBy(desc(proformaInvoices.createdAt), desc(proformaInvoices.id))
      .limit(opts.size)
      .offset(offset);

    return { rows, total: count ?? 0 };
  });
}

export type InvoiceWithItems = {
  invoice: ProformaInvoice;
  items: ProformaInvoiceItem[];
};

export async function getInvoiceWithItems(
  tenantId: string,
  id: string,
): Promise<InvoiceWithItems | null> {
  return tenantTransaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(proformaInvoices)
      .where(
        and(eq(proformaInvoices.tenantId, tenantId), eq(proformaInvoices.id, id)),
      )
      .limit(1);
    if (!invoice) return null;

    const items = await tx
      .select()
      .from(proformaInvoiceItems)
      .where(eq(proformaInvoiceItems.invoiceId, id))
      .orderBy(proformaInvoiceItems.sortOrder);

    return { invoice, items };
  });
}

/** Seller block from the tenant's most recent PI, to prefill the form. */
export async function getLatestSeller(
  tenantId: string,
): Promise<InvoiceSeller | null> {
  return tenantTransaction(async (tx) => {
    const [row] = await tx
      .select({ seller: proformaInvoices.seller })
      .from(proformaInvoices)
      .where(eq(proformaInvoices.tenantId, tenantId))
      .orderBy(desc(proformaInvoices.createdAt))
      .limit(1);
    return row?.seller ?? null;
  });
}
