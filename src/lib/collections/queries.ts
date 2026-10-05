import 'server-only';

import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  collectionSettings,
  dealCreditTerms,
  deals,
  invoicePayments,
  proformaInvoices,
  type DealCreditTermsRow,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { fiscalYearRange } from '@/lib/targets/fiscal';
import { toISODate } from '@/lib/targets/fy-attribution';
import { fiscalQuarters, splitAnnualTarget } from '@/lib/targets/quarters';
import { listTargets } from '@/lib/targets/queries';
import { QUOTA_CREDIT_SQL } from '@/lib/targets/quota-credit';

import {
  DEFAULT_COLLECTION_SETTINGS,
  invoiceStatus,
  type BookedDealIn,
  type CollectionSettings,
  type CreditTermsIn,
  type DiagnosticInput,
  type InvoiceIn,
  type InvoiceStatus,
} from './diagnostic';

/* ------------------------------------------------------------------ *
 * Settings                                                            *
 * ------------------------------------------------------------------ */

export async function getCollectionSettings(tenantId: string): Promise<CollectionSettings & { saved: boolean }> {
  const [row] = await tenantTransaction((tx) =>
    tx.select().from(collectionSettings).where(eq(collectionSettings.tenantId, tenantId)).limit(1),
  );
  if (!row) return { ...DEFAULT_COLLECTION_SETTINGS, saved: false };
  return { standardCreditDays: row.standardCreditDays, materialExcessDays: row.materialExcessDays, saved: true };
}

export async function saveCollectionSettings(tenantId: string, actorId: string, s: CollectionSettings): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .insert(collectionSettings)
      .values({ tenantId, ...s, updatedBy: actorId })
      .onConflictDoUpdate({
        target: collectionSettings.tenantId,
        set: { ...s, updatedBy: actorId, updatedAt: new Date() },
      }),
  );
}

/* ------------------------------------------------------------------ *
 * Deal credit terms                                                   *
 * ------------------------------------------------------------------ */

export function toTermsIn(row: Pick<DealCreditTermsRow, 'agreedCreditDays' | 'approvedBy' | 'approvedAt'> | null | undefined): CreditTermsIn {
  if (!row) return null;
  return {
    agreedCreditDays: row.agreedCreditDays,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  };
}

export async function getDealCreditTerms(tenantId: string, dealId: string): Promise<DealCreditTermsRow | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(dealCreditTerms)
      .where(and(eq(dealCreditTerms.tenantId, tenantId), eq(dealCreditTerms.dealId, dealId)))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Set (or change) a deal's agreed credit days. Changing the days clears any
 * earlier approval — sign-off covers specific terms, not "whatever this deal
 * says later". If the person setting a longer-than-standard period may
 * approve it themselves, it is recorded as approved by them; otherwise it
 * waits for someone who can.
 */
export async function setDealCreditTerms(input: {
  tenantId: string;
  dealId: string;
  actorId: string;
  days: number;
  note: string | null;
  actorCanApprove: boolean;
  settings: CollectionSettings;
}): Promise<{ needsApproval: boolean; approved: boolean }> {
  const over = input.days > input.settings.standardCreditDays;
  const selfApprove = over && input.actorCanApprove;
  const now = new Date();
  return await tenantTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(dealCreditTerms)
      .where(and(eq(dealCreditTerms.tenantId, input.tenantId), eq(dealCreditTerms.dealId, input.dealId)))
      .for('update')
      .limit(1);
    const daysChanged = !existing || existing.agreedCreditDays !== input.days;
    const approvedBy = selfApprove ? input.actorId : daysChanged ? null : (existing?.approvedBy ?? null);
    const approvedAt = selfApprove ? now : daysChanged ? null : (existing?.approvedAt ?? null);
    if (existing) {
      await tx
        .update(dealCreditTerms)
        .set({
          agreedCreditDays: input.days,
          note: input.note,
          setBy: daysChanged ? input.actorId : existing.setBy,
          agreedAt: daysChanged ? now : existing.agreedAt,
          approvedBy: over ? approvedBy : null,
          approvedAt: over ? approvedAt : null,
          updatedAt: now,
        })
        .where(eq(dealCreditTerms.id, existing.id));
    } else {
      await tx.insert(dealCreditTerms).values({
        tenantId: input.tenantId,
        dealId: input.dealId,
        agreedCreditDays: input.days,
        note: input.note,
        setBy: input.actorId,
        approvedBy: over ? approvedBy : null,
        approvedAt: over ? approvedAt : null,
      });
    }
    return { needsApproval: over, approved: over && approvedBy !== null };
  });
}

export async function approveDealCreditTerms(tenantId: string, dealId: string, actorId: string): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(dealCreditTerms)
      .set({ approvedBy: actorId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(dealCreditTerms.tenantId, tenantId), eq(dealCreditTerms.dealId, dealId)))
      .returning({ id: dealCreditTerms.id }),
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * Invoice ↔ deal, payments                                            *
 * ------------------------------------------------------------------ */

export type InvoiceCollectionView = {
  invoiceId: string;
  piNumber: string;
  invoiceDate: string;
  totalMinor: number;
  currency: string;
  createdBy: string | null;
  dealId: string | null;
  dealName: string | null;
  dealOwnerId: string | null;
  creditDaysOverride: number | null;
  dealTerms: CreditTermsIn;
  payments: Array<{ id: string; amountMinor: number; paidOn: string; reference: string | null; note: string | null; recordedBy: string | null }>;
  status: InvoiceStatus;
  standardCreditDays: number;
};

async function loadInvoiceIns(tenantId: string, filter: { ids?: string[]; fromDate?: string }): Promise<Array<InvoiceIn & { currency: string; createdBy: string | null; dealName: string | null }>> {
  return await tenantTransaction(async (tx) => {
    const conds = [eq(proformaInvoices.tenantId, tenantId)];
    if (filter.ids) conds.push(inArray(proformaInvoices.id, filter.ids));
    if (filter.fromDate) conds.push(sql`${proformaInvoices.piDate} >= ${filter.fromDate}`);
    const invs = await tx
      .select({
        id: proformaInvoices.id,
        piNumber: proformaInvoices.piNumber,
        piDate: proformaInvoices.piDate,
        totalMinor: proformaInvoices.totalMinor,
        currency: proformaInvoices.currency,
        createdBy: proformaInvoices.createdBy,
        dealId: proformaInvoices.dealId,
        creditDays: proformaInvoices.creditDays,
        dealName: deals.name,
        ownerId: deals.ownerId,
        termDays: dealCreditTerms.agreedCreditDays,
        termApprovedBy: dealCreditTerms.approvedBy,
        termApprovedAt: dealCreditTerms.approvedAt,
      })
      .from(proformaInvoices)
      .leftJoin(deals, and(eq(deals.id, proformaInvoices.dealId), isNull(deals.deletedAt)))
      .leftJoin(dealCreditTerms, eq(dealCreditTerms.dealId, proformaInvoices.dealId))
      .where(and(...conds));
    if (invs.length === 0) return [];
    const pays = await tx
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), inArray(invoicePayments.invoiceId, invs.map((i) => i.id))));
    const byInvoice = new Map<string, Array<{ amountMinor: number; paidOn: string }>>();
    for (const p of pays) {
      const list = byInvoice.get(p.invoiceId) ?? [];
      list.push({ amountMinor: p.amountMinor, paidOn: p.paidOn });
      byInvoice.set(p.invoiceId, list);
    }
    return invs.map((i) => ({
      invoiceId: i.id,
      piNumber: i.piNumber,
      dealId: i.dealId,
      ownerId: i.ownerId ?? null,
      invoiceDate: i.piDate,
      totalMinor: i.totalMinor,
      creditDaysOverride: i.creditDays,
      dealTerms:
        i.termDays != null
          ? { agreedCreditDays: i.termDays, approvedBy: i.termApprovedBy, approvedAt: i.termApprovedAt ? i.termApprovedAt.toISOString() : null }
          : null,
      payments: byInvoice.get(i.id) ?? [],
      currency: i.currency,
      createdBy: i.createdBy,
      dealName: i.dealName ?? null,
    }));
  });
}

export async function getInvoiceCollection(tenantId: string, invoiceId: string, asOf: string): Promise<InvoiceCollectionView | null> {
  const [inv] = await loadInvoiceIns(tenantId, { ids: [invoiceId] });
  if (!inv) return null;
  const settings = await getCollectionSettings(tenantId);
  const payments = await tenantTransaction((tx) =>
    tx
      .select()
      .from(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), eq(invoicePayments.invoiceId, invoiceId)))
      .orderBy(asc(invoicePayments.paidOn), asc(invoicePayments.createdAt)),
  );
  return {
    invoiceId: inv.invoiceId,
    piNumber: inv.piNumber,
    invoiceDate: inv.invoiceDate,
    totalMinor: inv.totalMinor,
    currency: inv.currency,
    createdBy: inv.createdBy,
    dealId: inv.dealId,
    dealName: inv.dealName,
    dealOwnerId: inv.ownerId,
    creditDaysOverride: inv.creditDaysOverride,
    dealTerms: inv.dealTerms,
    payments: payments.map((p) => ({
      id: p.id,
      amountMinor: p.amountMinor,
      paidOn: p.paidOn,
      reference: p.reference,
      note: p.note,
      recordedBy: p.recordedBy,
    })),
    status: invoiceStatus(inv, settings, asOf),
    standardCreditDays: settings.standardCreditDays,
  };
}

/** Collection status for a page of invoices (the list's Status column). */
export async function invoiceStatusesFor(tenantId: string, ids: string[], asOf: string): Promise<Map<string, InvoiceStatus>> {
  if (ids.length === 0) return new Map();
  const [rows, settings] = await Promise.all([loadInvoiceIns(tenantId, { ids }), getCollectionSettings(tenantId)]);
  return new Map(rows.map((r) => [r.invoiceId, invoiceStatus(r, settings, asOf)]));
}

export async function setInvoiceDeal(input: {
  tenantId: string;
  invoiceId: string;
  dealId: string | null;
  creditDays: number | null;
}): Promise<'ok' | 'deal_not_found'> {
  return await tenantTransaction(async (tx) => {
    if (input.dealId) {
      const [d] = await tx
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.tenantId, input.tenantId), eq(deals.id, input.dealId), isNull(deals.deletedAt)))
        .limit(1);
      if (!d) return 'deal_not_found';
    }
    await tx
      .update(proformaInvoices)
      .set({ dealId: input.dealId, creditDays: input.creditDays })
      .where(and(eq(proformaInvoices.tenantId, input.tenantId), eq(proformaInvoices.id, input.invoiceId)));
    return 'ok';
  });
}

export async function addInvoicePayment(input: {
  tenantId: string;
  invoiceId: string;
  actorId: string;
  amountMinor: number;
  paidOn: string;
  reference: string | null;
  note: string | null;
}): Promise<void> {
  await tenantTransaction((tx) =>
    tx.insert(invoicePayments).values({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      paidOn: input.paidOn,
      reference: input.reference,
      note: input.note,
      recordedBy: input.actorId,
    }),
  );
}

export async function deleteInvoicePayment(tenantId: string, paymentId: string): Promise<string | null> {
  const rows = await tenantTransaction((tx) =>
    tx
      .delete(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), eq(invoicePayments.id, paymentId)))
      .returning({ invoiceId: invoicePayments.invoiceId }),
  );
  return rows[0]?.invoiceId ?? null;
}

export async function invoiceHasPayments(tenantId: string, invoiceId: string): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), eq(invoicePayments.invoiceId, invoiceId)))
      .limit(1),
  );
  return rows.length > 0;
}

export type DealOption ={ id: string; name: string; ownerId: string | null; stage: string; company: string | null };

/**
 * Deals an invoice can be linked to: not lost, not deleted, newest first.
 * Members see only their own deals, the same scoping as their invoice list.
 */
export async function listInvoiceDealOptions(tenantId: string, onlyOwnerId?: string): Promise<DealOption[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select({
        id: deals.id,
        name: deals.name,
        ownerId: deals.ownerId,
        stage: deals.stage,
        company: deals.companyNameText,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          isNull(deals.deletedAt),
          ne(deals.stage, 'lost'),
          onlyOwnerId ? eq(deals.ownerId, onlyOwnerId) : undefined,
        ),
      )
      .orderBy(desc(deals.updatedAt))
      .limit(300),
  );
  return rows.map((r) => ({ ...r, stage: String(r.stage) }));
}

/* ------------------------------------------------------------------ *
 * Report input                                                        *
 * ------------------------------------------------------------------ */

export type ReportPeriod = 'fy' | 'q1' | 'q2' | 'q3' | 'q4';

export function periodWindow(
  startMonth: number,
  fiscalYear: number,
  period: ReportPeriod,
): { start: string; end: string; targetShare: (annual: number) => number } {
  if (period === 'fy') {
    const { start, end } = fiscalYearRange(startMonth, fiscalYear);
    return { start: toISODate(start), end: toISODate(end), targetShare: (a) => a };
  }
  const idx = Number(period.slice(1)) as 1 | 2 | 3 | 4;
  const q = fiscalQuarters(startMonth, fiscalYear)[idx - 1]!;
  return {
    start: toISODate(q.start),
    end: toISODate(q.end),
    // Same straight-line split Targets uses, so the two pages agree.
    targetShare: (a) => splitAnnualTarget(a)[idx - 1]!,
  };
}

/**
 * Everything `buildDiagnostic` needs, read in four queries. Booked deals use
 * the same quota-credit rule as Targets (approval none/approved).
 */
export async function loadDiagnosticInput(input: {
  tenantId: string;
  fiscalYear: number;
  startMonth: number;
  period: ReportPeriod;
  asOf: string;
}): Promise<DiagnosticInput> {
  const w = periodWindow(input.startMonth, input.fiscalYear, input.period);
  const credited = sql.raw(QUOTA_CREDIT_SQL);
  const [settings, dealRows, targets] = await Promise.all([
    getCollectionSettings(input.tenantId),
    tenantTransaction((tx) =>
      tx.execute(sql`
        SELECT d.id, d.name, d.owner_id, d.amount_minor,
               (d.closed_at AT TIME ZONE 'UTC')::date::text AS closed_on,
               t.agreed_credit_days, t.approved_by, t.approved_at
        FROM deals d
        LEFT JOIN deal_credit_terms t ON t.deal_id = d.id
        WHERE d.tenant_id = ${input.tenantId}::uuid
          AND d.stage = 'won'
          AND d.deleted_at IS NULL
          AND d.owner_id IS NOT NULL
          AND (${credited})
          AND d.closed_at >= ${w.start}::date
          AND d.closed_at <  ${w.end}::date
      `),
    ) as Promise<unknown> as Promise<
      Array<{
        id: string;
        name: string;
        owner_id: string;
        amount_minor: string | number;
        closed_on: string;
        agreed_credit_days: number | null;
        approved_by: string | null;
        approved_at: string | Date | null;
      }>
    >,
    listTargets(input.tenantId, input.fiscalYear),
  ]);
  // Invoices from two years before the window: enough to see collection on
  // anything a deal in the window was billed for, without reading all history.
  const invoices = await loadInvoiceIns(input.tenantId, { fromDate: addYearsISO(w.start, -2) });

  const bookedDeals: BookedDealIn[] = dealRows.map((r) => ({
    dealId: r.id,
    name: r.name,
    ownerId: r.owner_id,
    amountMinor: Number(r.amount_minor) || 0,
    closedOn: r.closed_on,
    terms:
      r.agreed_credit_days != null
        ? {
            agreedCreditDays: r.agreed_credit_days,
            approvedBy: r.approved_by,
            approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
          }
        : null,
  }));
  const targetMap = new Map<string, number>();
  for (const t of targets) if (t.revenueTargetMinor > 0) targetMap.set(t.userId, w.targetShare(t.revenueTargetMinor));

  return {
    settings: { standardCreditDays: settings.standardCreditDays, materialExcessDays: settings.materialExcessDays },
    period: { start: w.start, end: w.end },
    asOf: input.asOf,
    deals: bookedDeals,
    invoices,
    targets: targetMap,
    owners: [...targetMap.keys()],
  };
}

function addYearsISO(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
