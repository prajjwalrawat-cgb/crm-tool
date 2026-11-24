import 'server-only';

import { and, asc, desc, eq, gt, gte, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  companies,
  contacts,
  deals,
  invoiceSellerProfiles,
  organizationSettings,
  quoteItems,
  quoteSettings,
  quoteTemplates,
  quotes,
  users,
} from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';
import { applyDealPatch } from '@/lib/deals/patch';
import { stateNameFromCode } from '@/lib/invoices/seller-profiles';
import type { PdfSeller } from '@/lib/invoices/types';

import { defaultTemplateBody } from './default-template';
import { allocateQuoteNumber } from './numbering';
import {
  quoteDraftInputSchema,
  quoteSettingsInputSchema,
  type QuoteDraftInput,
  type QuoteSettingsInput,
} from './schema';
import {
  defaultContentFor,
  mergeContentForTemplate,
  quoteTemplateBodySchema,
  type QuoteContent,
  type QuoteTemplateBody,
} from './template-schema';
import { computeQuoteTotals, QuoteTotalsError, type OverallDiscount, type QuoteTotals } from './totals';
import type {
  QuoteDetail,
  QuoteListItem,
  QuoteParty,
  QuoteSettings,
  QuoteStatus,
  QuoteTemplateRow,
} from './types';

/**
 * Quote + quote-template data layer. Every function runs inside
 * `tenantTransaction` (RLS) and also filters on `tenantId` explicitly. The
 * caller must have entered a tenant context and checked permissions.
 */

export class QuoteFrozenError extends Error {
  constructor() {
    super('This quote was sent and is locked. Create a revision to change it.');
    this.name = 'QuoteFrozenError';
  }
}

export class QuoteNotFoundError extends Error {
  constructor(what: 'Quote' | 'Deal' | 'Quote template' = 'Quote') {
    super(`${what} not found.`);
    this.name = 'QuoteNotFoundError';
  }
}

/** A request the business rules refuse (revise a non-latest quote, archive the default, …). */
export class QuoteRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteRuleError';
  }
}

const STARTER_TEMPLATE_NAME = 'Standard quotation';
const DEFAULT_SETTINGS: QuoteSettings = {
  numberPrefix: 'Q',
  numberSeparator: '/',
  numberIncludeFy: true,
  numberPadding: 4,
  defaultValidityDays: 30,
};

const isUuid = (v: string) => z.uuid().safeParse(v).success;

/** Today's date in India (Asia/Kolkata), YYYY-MM-DD. */
function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Drop empty / missing values so the jsonb party blocks stay tidy. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')),
  ) as T;
}

function fieldError(path: (string | number)[], message: string): z.ZodError {
  return new z.ZodError([{ code: 'custom', path, message, input: undefined }]);
}

/* ---------------------------------------------------------------- seller */

type SellerProfileRow = typeof invoiceSellerProfiles.$inferSelect;

/** The seller block a quote prints, from one seller profile row. */
function sellerOfProfile(r: SellerProfileRow): PdfSeller {
  return compact<PdfSeller>({
    name: r.sellerName,
    address: r.address ?? undefined,
    gstin: r.gstin ?? undefined,
    pan: r.pan ?? undefined,
    cin: r.cin ?? undefined,
    bankName: r.bankName ?? undefined,
    bankAccount: r.bankAccount ?? undefined,
    bankIfsc: r.bankIfsc ?? undefined,
    bankBranch: r.bankBranch ?? undefined,
    stateCode: r.stateCode,
    state: stateNameFromCode(r.stateCode),
  });
}

async function sellerFromProfile(
  tx: DbExecutor,
  tenantId: string,
  profileId?: string,
): Promise<{ id: string; seller: PdfSeller } | null> {
  const where = profileId
    ? and(eq(invoiceSellerProfiles.tenantId, tenantId), eq(invoiceSellerProfiles.id, profileId))
    : eq(invoiceSellerProfiles.tenantId, tenantId);
  // Same order as listSellerProfiles: the "first" profile is the lowest state code.
  const [r] = await tx
    .select()
    .from(invoiceSellerProfiles)
    .where(where)
    .orderBy(asc(invoiceSellerProfiles.stateCode))
    .limit(1);
  if (!r) return null;
  return { id: r.id, seller: sellerOfProfile(r) };
}

export type QuoteSellerChoice = { id: string; label: string; seller: PdfSeller };

/**
 * The seller profiles (Invoice settings → Seller details by state) a quote
 * can be issued from, lowest state code first: the editor's Seller select.
 */
export async function listQuoteSellerChoices(tenantId: string): Promise<QuoteSellerChoice[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(invoiceSellerProfiles)
      .where(eq(invoiceSellerProfiles.tenantId, tenantId))
      .orderBy(asc(invoiceSellerProfiles.stateCode)),
  );
  return rows.map((r) => {
    const state = stateNameFromCode(r.stateCode) || r.stateCode;
    return { id: r.id, label: r.gstin ? `${state} · ${r.gstin}` : state, seller: sellerOfProfile(r) };
  });
}

/** Fallback when the tenant has no seller profiles: the invoice seller fields in organization_settings. */
async function sellerFromOrgSettings(tx: DbExecutor, tenantId: string): Promise<PdfSeller> {
  const [o] = await tx
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.tenantId, tenantId))
    .limit(1);
  return compact<PdfSeller>({
    name: o?.invoiceSellerName ?? '',
    address: o?.invoiceSellerAddress ?? undefined,
    gstin: o?.invoiceGstin ?? undefined,
    pan: o?.invoicePan ?? undefined,
    cin: o?.invoiceCin ?? undefined,
    bankName: o?.invoiceBankName ?? undefined,
    bankAccount: o?.invoiceBankAccount ?? undefined,
    bankIfsc: o?.invoiceBankIfsc ?? undefined,
    bankBranch: o?.invoiceBankBranch ?? undefined,
  });
}

/* ------------------------------------------------------------- templates */

/** Insert the starter template when the tenant has none (inside the caller's transaction). */
async function insertStarterIfNone(tx: DbExecutor, tenantId: string, userId: string): Promise<void> {
  const body = JSON.stringify(defaultTemplateBody());
  // NOT EXISTS + ON CONFLICT (the one-default partial unique index) makes
  // concurrent first visits create exactly one starter.
  await tx.execute(sql`
    INSERT INTO quote_templates (tenant_id, name, is_default, body, updated_by)
    SELECT ${tenantId}, ${STARTER_TEMPLATE_NAME}, true, ${body}::jsonb, ${userId}
    WHERE NOT EXISTS (SELECT 1 FROM quote_templates WHERE tenant_id = ${tenantId})
    ON CONFLICT DO NOTHING
  `);
}

export async function ensureStarterTemplate(tenantId: string, userId: string): Promise<void> {
  await tenantTransaction((tx) => insertStarterIfNone(tx, tenantId, userId));
}

export async function listQuoteTemplates(
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<QuoteTemplateRow[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select()
      .from(quoteTemplates)
      .where(
        and(
          eq(quoteTemplates.tenantId, tenantId),
          opts.includeArchived ? undefined : isNull(quoteTemplates.archivedAt),
        ),
      )
      .orderBy(desc(quoteTemplates.isDefault), asc(quoteTemplates.name), asc(quoteTemplates.createdAt)),
  );
  return rows as QuoteTemplateRow[];
}

/** Active templates' ids and names only (the "New quote" picker), same order as listQuoteTemplates. */
export async function listQuoteTemplateOptions(
  tenantId: string,
): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  return tenantTransaction((tx) =>
    tx
      .select({ id: quoteTemplates.id, name: quoteTemplates.name, isDefault: quoteTemplates.isDefault })
      .from(quoteTemplates)
      .where(and(eq(quoteTemplates.tenantId, tenantId), isNull(quoteTemplates.archivedAt)))
      .orderBy(desc(quoteTemplates.isDefault), asc(quoteTemplates.name), asc(quoteTemplates.createdAt)),
  );
}

export async function getQuoteTemplate(tenantId: string, id: string): Promise<QuoteTemplateRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(quoteTemplates)
      .where(and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.id, id)))
      .limit(1),
  );
  return (row as QuoteTemplateRow | undefined) ?? null;
}

const templateNameSchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(120) });

/**
 * Create or update a template. The body is validated with
 * `quoteTemplateBodySchema` (ZodError paths start at `sections`/`theme`); the
 * name error path is `name`. A new template becomes the default when the
 * tenant has no active default.
 */
export async function saveQuoteTemplate(
  tenantId: string,
  userId: string,
  input: { id?: string; name: string; body: unknown },
): Promise<{ id: string }> {
  const { name } = templateNameSchema.parse({ name: input.name });
  const body = quoteTemplateBodySchema.parse(input.body);

  return tenantTransaction(async (tx) => {
    if (input.id !== undefined) {
      if (!isUuid(input.id)) throw new QuoteNotFoundError('Quote template');
      const [row] = await tx
        .update(quoteTemplates)
        .set({ name, body, updatedBy: userId, updatedAt: new Date() })
        .where(
          and(
            eq(quoteTemplates.tenantId, tenantId),
            eq(quoteTemplates.id, input.id),
            isNull(quoteTemplates.archivedAt),
          ),
        )
        .returning({ id: quoteTemplates.id });
      if (!row) throw new QuoteNotFoundError('Quote template');
      return row;
    }
    const [hasDefault] = await tx
      .select({ id: quoteTemplates.id })
      .from(quoteTemplates)
      .where(
        and(
          eq(quoteTemplates.tenantId, tenantId),
          eq(quoteTemplates.isDefault, true),
          isNull(quoteTemplates.archivedAt),
        ),
      )
      .limit(1);
    const [row] = await tx
      .insert(quoteTemplates)
      .values({ tenantId, name, body, isDefault: !hasDefault, updatedBy: userId })
      .returning({ id: quoteTemplates.id });
    return row!;
  });
}

export async function duplicateQuoteTemplate(
  tenantId: string,
  userId: string,
  id: string,
): Promise<{ id: string }> {
  if (!isUuid(id)) throw new QuoteNotFoundError('Quote template');
  return tenantTransaction(async (tx) => {
    const [src] = await tx
      .select()
      .from(quoteTemplates)
      .where(and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.id, id)))
      .limit(1);
    if (!src) throw new QuoteNotFoundError('Quote template');
    const [row] = await tx
      .insert(quoteTemplates)
      .values({ tenantId, name: `${src.name} (copy)`, body: src.body, isDefault: false, updatedBy: userId })
      .returning({ id: quoteTemplates.id });
    return row!;
  });
}

export async function setDefaultQuoteTemplate(tenantId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new QuoteNotFoundError('Quote template');
  await tenantTransaction(async (tx) => {
    // Lock every active template (in a fixed order, so concurrent callers
    // queue instead of deadlocking): two setDefault calls on different
    // targets then serialize rather than racing into the unique index.
    const active = await tx
      .select({ id: quoteTemplates.id })
      .from(quoteTemplates)
      .where(and(eq(quoteTemplates.tenantId, tenantId), isNull(quoteTemplates.archivedAt)))
      .orderBy(asc(quoteTemplates.id))
      .for('update');
    if (!active.some((t) => t.id === id)) throw new QuoteNotFoundError('Quote template');
    // Clear first: the one-default partial unique index is not deferrable.
    await tx
      .update(quoteTemplates)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.isDefault, true), ne(quoteTemplates.id, id)),
      );
    await tx
      .update(quoteTemplates)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.id, id)));
  });
}

export async function archiveQuoteTemplate(tenantId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new QuoteNotFoundError('Quote template');
  await tenantTransaction(async (tx) => {
    const [t] = await tx
      .select({ isDefault: quoteTemplates.isDefault, archivedAt: quoteTemplates.archivedAt })
      .from(quoteTemplates)
      .where(and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.id, id)))
      .for('update');
    if (!t) throw new QuoteNotFoundError('Quote template');
    if (t.isDefault) {
      throw new QuoteRuleError("The default template can't be archived. Make another template the default first.");
    }
    if (t.archivedAt) return;
    await tx
      .update(quoteTemplates)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(quoteTemplates.tenantId, tenantId), eq(quoteTemplates.id, id)));
  });
}

/** Active template by id, or the tenant's default when id is omitted. Body re-validated. */
async function loadActiveTemplate(
  tx: DbExecutor,
  tenantId: string,
  id: string | null | undefined,
): Promise<{ id: string; body: QuoteTemplateBody }> {
  if (id != null && !isUuid(id)) throw new QuoteNotFoundError('Quote template');
  const [t] = await tx
    .select({ id: quoteTemplates.id, body: quoteTemplates.body })
    .from(quoteTemplates)
    .where(
      and(
        eq(quoteTemplates.tenantId, tenantId),
        isNull(quoteTemplates.archivedAt),
        id != null ? eq(quoteTemplates.id, id) : eq(quoteTemplates.isDefault, true),
      ),
    )
    .limit(1);
  if (!t) throw new QuoteNotFoundError('Quote template');
  return { id: t.id, body: quoteTemplateBodySchema.parse(t.body) };
}

/* -------------------------------------------------------------- settings */

async function loadSettings(tx: DbExecutor, tenantId: string): Promise<QuoteSettings> {
  const [s] = await tx.select().from(quoteSettings).where(eq(quoteSettings.tenantId, tenantId)).limit(1);
  if (!s) return { ...DEFAULT_SETTINGS };
  return {
    numberPrefix: s.numberPrefix,
    numberSeparator: s.numberSeparator,
    numberIncludeFy: s.numberIncludeFy,
    numberPadding: s.numberPadding,
    defaultValidityDays: s.defaultValidityDays,
  };
}

export async function getQuoteSettings(tenantId: string): Promise<QuoteSettings> {
  return tenantTransaction((tx) => loadSettings(tx, tenantId));
}

export async function saveQuoteSettings(
  tenantId: string,
  userId: string,
  input: QuoteSettingsInput,
): Promise<void> {
  const values = quoteSettingsInputSchema.parse(input);
  await tenantTransaction((tx) =>
    tx
      .insert(quoteSettings)
      .values({ tenantId, ...values, updatedBy: userId })
      .onConflictDoUpdate({
        target: quoteSettings.tenantId,
        set: { ...values, updatedBy: userId, updatedAt: new Date() },
      }),
  );
}

/* ---------------------------------------------------------------- quotes */

function overallOf(row: { overallDiscountType: string; overallDiscountValue: number }): OverallDiscount {
  if (row.overallDiscountType === 'amount') return { type: 'amount', valueMinor: row.overallDiscountValue };
  if (row.overallDiscountType === 'percent') return { type: 'percent', bps: row.overallDiscountValue };
  return { type: 'none' };
}

async function loadDetail(tx: DbExecutor, tenantId: string, id: string): Promise<QuoteDetail | null> {
  const [row] = await tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)))
    .limit(1);
  if (!row) return null;
  const items = await tx
    .select()
    .from(quoteItems)
    .where(and(eq(quoteItems.tenantId, tenantId), eq(quoteItems.quoteId, id)))
    .orderBy(asc(quoteItems.sortOrder));
  const totals: QuoteTotals = computeQuoteTotals(
    items.map((i) => ({
      quantity: Number(i.quantity),
      rateMinor: i.rateMinor,
      discountBps: i.discountBps,
      taxRateBps: i.taxRateBps,
    })),
    overallOf(row),
  );
  return {
    ...row,
    templateSnapshot: row.templateSnapshot as QuoteTemplateBody,
    content: row.content as QuoteContent,
    seller: row.seller as PdfSeller,
    buyer: row.buyer as QuoteParty,
    consignee: (row.consignee as QuoteParty | null) ?? null,
    items: items.map((i, idx) => ({ ...i, totals: totals.lines[idx]! })),
    totals,
  };
}

export async function getQuote(tenantId: string, id: string): Promise<QuoteDetail | null> {
  if (!isUuid(id)) return null;
  return tenantTransaction((tx) => loadDetail(tx, tenantId, id));
}

const MAX_NUMBER_ATTEMPTS = 20;

/** Postgres unique violation on (tenant_id, quote_number, revision). */
function isQuoteNumberTaken(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: string; constraint_name?: string; constraint?: string };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === 'quotes_number_revision_uq') return true;
  }
  return false;
}

/**
 * Which deals a user may link a quote to. `ownerOrUnassigned` set = sales
 * persona (member / viewer): only deals they own or nobody owns, the same
 * rule the Deals page applies. Unset = every deal in the workspace.
 */
export type QuoteDealScope = { ownerOrUnassigned?: string };

function dealScopeCondition(scope: QuoteDealScope): SQL | undefined {
  const me = scope.ownerOrUnassigned;
  return me ? sql`(${deals.ownerId} = ${me} OR ${deals.ownerId} IS NULL)` : undefined;
}

/**
 * The buyer a quote linked to `dealId` starts with (the deal's company and
 * contact). Throws QuoteNotFoundError('Deal') when the deal is missing,
 * deleted or outside `scope`.
 */
async function buyerFromDeal(
  tx: DbExecutor,
  tenantId: string,
  dealId: string,
  scope: QuoteDealScope,
): Promise<QuoteParty> {
  if (!isUuid(dealId)) throw new QuoteNotFoundError('Deal');
  const [d] = await tx
    .select({
      companyName: companies.name,
      companyNameText: deals.companyNameText,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      contactEmail: contacts.email,
      contactNameText: deals.contactNameText,
      contactEmailText: deals.contactEmailText,
    })
    .from(deals)
    .leftJoin(companies, and(eq(companies.id, deals.companyId), isNull(companies.deletedAt)))
    .leftJoin(contacts, and(eq(contacts.id, deals.contactId), isNull(contacts.deletedAt)))
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, dealId), isNull(deals.deletedAt), dealScopeCondition(scope)))
    .limit(1);
  if (!d) throw new QuoteNotFoundError('Deal');
  const contactName =
    [d.contactFirst, d.contactLast].filter((s) => s && s.trim()).join(' ').trim() || d.contactNameText || undefined;
  return compact<QuoteParty>({
    name: d.companyName ?? d.companyNameText ?? contactName ?? '',
    contactName,
    contactEmail: d.contactEmail ?? d.contactEmailText ?? undefined,
  });
}

/**
 * New draft quote. With a `dealId` the buyer is prefilled from the deal's
 * company and contact; with `dealId: null` the quote stands alone and the
 * buyer starts empty (filled in the editor).
 */
export async function createQuote(
  tenantId: string,
  userId: string,
  input: { dealId: string | null; templateId?: string },
  scope: QuoteDealScope = {},
): Promise<{ id: string; quoteNumber: string }> {
  if (input.dealId !== null && !isUuid(input.dealId)) throw new QuoteNotFoundError('Deal');
  const dealId = input.dealId;

  return tenantTransaction(async (tx) => {
    const buyer: QuoteParty = dealId !== null ? await buyerFromDeal(tx, tenantId, dealId, scope) : { name: '' };

    // Only after the deal is confirmed, so a bad id leaves no starter behind.
    await insertStarterIfNone(tx, tenantId, userId);
    const template = await loadActiveTemplate(tx, tenantId, input.templateId);
    const settings = await loadSettings(tx, tenantId);

    const profile = await sellerFromProfile(tx, tenantId);
    const seller = profile?.seller ?? (await sellerFromOrgSettings(tx, tenantId));

    const quoteDate = todayIst();
    const values = {
      tenantId,
      dealId,
      templateId: template.id,
      templateSnapshot: template.body,
      content: defaultContentFor(template.body),
      sellerProfileId: profile?.id ?? null,
      seller,
      buyer,
      consignee: null,
      quoteDate,
      validUntil: addDays(quoteDate, settings.defaultValidityDays),
      createdBy: userId,
      updatedBy: userId,
    };
    // A number-format change can make the sequence produce a number that
    // already exists; skip past taken numbers. Each insert runs in a savepoint
    // so a duplicate doesn't abort the transaction.
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
      const quoteNumber = await allocateQuoteNumber(tx, tenantId, quoteDate);
      try {
        const [row] = await tx.transaction((sp) =>
          sp.insert(quotes).values({ ...values, quoteNumber }).returning({ id: quotes.id }),
        );
        return { id: row!.id, quoteNumber };
      } catch (err) {
        if (!isQuoteNumberTaken(err)) throw err;
      }
    }
    throw new QuoteRuleError(
      'Could not find a free quote number. Check the number format in quote settings, or try again.',
    );
  });
}

/** Lock the quote row and require it to be an editable draft. */
async function lockDraft(tx: DbExecutor, tenantId: string, id: string) {
  const [cur] = await tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)))
    .for('update');
  if (!cur) throw new QuoteNotFoundError();
  if (cur.status !== 'draft') throw new QuoteFrozenError();
  return cur;
}

/**
 * Link a draft to a deal, move it to another deal, or unlink it
 * (`dealId: null`). A draft with no client name yet takes the new deal's
 * company and contact; a client already typed in is kept. Sent quotes are
 * locked: link a new revision instead.
 */
export async function setQuoteDeal(
  tenantId: string,
  userId: string,
  id: string,
  dealId: string | null,
  scope: QuoteDealScope = {},
): Promise<{ previousDealId: string | null }> {
  if (!isUuid(id)) throw new QuoteNotFoundError();
  return tenantTransaction(async (tx) => {
    const cur = await lockDraft(tx, tenantId, id);
    const set: Partial<typeof quotes.$inferInsert> = { dealId, updatedBy: userId, updatedAt: new Date() };
    if (dealId !== null) {
      const dealBuyer = await buyerFromDeal(tx, tenantId, dealId, scope);
      if (!(cur.buyer as QuoteParty | null)?.name?.trim()) set.buyer = dealBuyer;
    }
    await tx.update(quotes).set(set).where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)));
    return { previousDealId: cur.dealId };
  });
}

/**
 * Replace a draft's header and items. Totals are recomputed server-side;
 * input ZodErrors and a refused discount (path `overallDiscount`) are thrown
 * as ZodError. A missing seller profile is a ZodError on `sellerProfileId`.
 */
export async function updateQuoteDraft(
  tenantId: string,
  userId: string,
  id: string,
  input: QuoteDraftInput,
): Promise<QuoteDetail> {
  if (!isUuid(id)) throw new QuoteNotFoundError();
  const data = quoteDraftInputSchema.parse(input);

  let totals: QuoteTotals;
  try {
    totals = computeQuoteTotals(data.items, data.overallDiscount);
  } catch (err) {
    if (err instanceof QuoteTotalsError) {
      throw fieldError(err.code === 'discount_exceeds_subtotal' ? ['overallDiscount'] : ['items'], err.message);
    }
    throw err;
  }

  return tenantTransaction(async (tx) => {
    const cur = await lockDraft(tx, tenantId, id);

    let sellerProfileId: string | null = null;
    let seller: PdfSeller;
    if (data.sellerProfileId) {
      const p = await sellerFromProfile(tx, tenantId, data.sellerProfileId);
      if (!p) throw fieldError(['sellerProfileId'], 'Seller profile not found.');
      sellerProfileId = p.id;
      seller = p.seller;
    } else {
      seller = await sellerFromOrgSettings(tx, tenantId);
    }

    const content = mergeContentForTemplate(cur.templateSnapshot as QuoteTemplateBody, data.content);
    const od = data.overallDiscount;

    await tx.delete(quoteItems).where(and(eq(quoteItems.tenantId, tenantId), eq(quoteItems.quoteId, id)));
    await tx.insert(quoteItems).values(
      data.items.map((it, i) => ({
        tenantId,
        quoteId: id,
        sortOrder: i,
        description: it.description,
        hsnSac: it.hsnSac || null,
        unit: it.unit || null,
        quantity: it.quantity.toFixed(3),
        rateMinor: it.rateMinor,
        discountBps: it.discountBps,
        taxRateBps: it.taxRateBps,
        amountMinor: totals.lines[i]!.amountMinor,
        allocatedDiscountMinor: totals.lines[i]!.allocatedDiscountMinor,
        taxMinor: totals.lines[i]!.taxMinor,
        offeringId: it.offeringId ?? null,
        groupLabel: it.groupLabel || null,
      })),
    );
    await tx
      .update(quotes)
      .set({
        quoteDate: data.quoteDate,
        validUntil: data.validUntil,
        sellerProfileId,
        seller,
        buyer: compact<QuoteParty>(data.buyer),
        consignee: data.consignee ? compact<QuoteParty>(data.consignee) : null,
        content,
        overallDiscountType: od.type,
        overallDiscountValue: od.type === 'amount' ? od.valueMinor : od.type === 'percent' ? od.bps : 0,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)));

    return (await loadDetail(tx, tenantId, id))!;
  });
}

/**
 * Re-snapshot a draft from a template (the given one, else the quote's own
 * template, else the default), keeping content for sections that survive.
 */
export async function reapplyTemplate(
  tenantId: string,
  userId: string,
  id: string,
  templateId?: string,
): Promise<void> {
  if (!isUuid(id)) throw new QuoteNotFoundError();
  await tenantTransaction(async (tx) => {
    const cur = await lockDraft(tx, tenantId, id);
    let template: { id: string; body: QuoteTemplateBody };
    if (templateId !== undefined) {
      template = await loadActiveTemplate(tx, tenantId, templateId);
    } else {
      template = await loadActiveTemplate(tx, tenantId, cur.templateId).catch((err) => {
        // The quote's own template was archived/deleted: fall back to the default.
        if (err instanceof QuoteNotFoundError && cur.templateId) return loadActiveTemplate(tx, tenantId, null);
        throw err;
      });
    }
    await tx
      .update(quotes)
      .set({
        templateId: template.id,
        templateSnapshot: template.body,
        content: mergeContentForTemplate(template.body, cur.content as QuoteContent),
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)));
  });
}

/**
 * New draft revision of a sent quote: same number, revision + 1, snapshot,
 * content and items copied. The source's only change is status → superseded.
 */
export async function createQuoteRevision(
  tenantId: string,
  userId: string,
  id: string,
): Promise<{ id: string }> {
  if (!isUuid(id)) throw new QuoteNotFoundError();
  return tenantTransaction(async (tx) => {
    const [src] = await tx
      .select()
      .from(quotes)
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)))
      .for('update');
    if (!src) throw new QuoteNotFoundError();
    if (src.status !== 'sent') {
      throw new QuoteRuleError('Only a sent quote can be revised.');
    }
    const [newer] = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(
        and(
          eq(quotes.tenantId, tenantId),
          eq(quotes.quoteNumber, src.quoteNumber),
          gt(quotes.revision, src.revision),
        ),
      )
      .limit(1);
    if (newer) throw new QuoteRuleError('This quote already has a newer revision.');

    const settings = await loadSettings(tx, tenantId);
    const today = todayIst();

    const [row] = await tx
      .insert(quotes)
      .values({
        tenantId,
        dealId: src.dealId,
        quoteNumber: src.quoteNumber,
        revision: src.revision + 1,
        parentQuoteId: src.id,
        status: 'draft',
        templateId: src.templateId,
        templateSnapshot: src.templateSnapshot,
        content: src.content,
        sellerProfileId: src.sellerProfileId,
        seller: src.seller,
        buyer: src.buyer,
        consignee: src.consignee,
        // A revision is re-issued today with the tenant's standard validity.
        quoteDate: today,
        validUntil: addDays(today, settings.defaultValidityDays),
        currency: src.currency,
        overallDiscountType: src.overallDiscountType,
        overallDiscountValue: src.overallDiscountValue,
        subtotalMinor: src.subtotalMinor,
        discountMinor: src.discountMinor,
        taxMinor: src.taxMinor,
        totalMinor: src.totalMinor,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: quotes.id });

    const items = await tx
      .select()
      .from(quoteItems)
      .where(and(eq(quoteItems.tenantId, tenantId), eq(quoteItems.quoteId, src.id)))
      .orderBy(asc(quoteItems.sortOrder));
    if (items.length) {
      await tx
        .insert(quoteItems)
        .values(items.map((it) => ({ ...it, id: undefined, quoteId: row!.id })));
    }

    await tx
      .update(quotes)
      .set({ status: 'superseded' })
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, src.id)));
    return { id: row!.id };
  });
}

/* ----------------------------------------------------------------- lists */

const listColumns = {
  id: quotes.id,
  quoteNumber: quotes.quoteNumber,
  revision: quotes.revision,
  status: quotes.status,
  dealId: quotes.dealId,
  dealName: deals.name,
  // A quote without a deal shows its buyer as the client.
  companyName: sql<string | null>`coalesce(${companies.name}, ${deals.companyNameText}, nullif(${quotes.buyer}->>'name', ''))`,
  totalMinor: quotes.totalMinor,
  createdBy: quotes.createdBy,
  createdAt: quotes.createdAt,
  sentAt: quotes.sentAt,
};

/**
 * Which quotes a user may see and act on. `ownOnly` set = sales persona
 * (member / viewer): quotes where they created any revision of the same
 * quote number, or that are linked to a deal they own. Unset = all quotes.
 * Callers must join `deals` on `quotes.deal_id` (left join is fine).
 */
export type QuoteAccessScope = { ownOnly?: string };

function quoteAccessCondition(scope: QuoteAccessScope): SQL | undefined {
  const me = scope.ownOnly;
  if (!me) return undefined;
  return sql`(${deals.ownerId} = ${me} OR EXISTS (
    SELECT 1 FROM quotes own
    WHERE own.tenant_id = ${quotes.tenantId}
      AND own.quote_number = ${quotes.quoteNumber}
      AND own.created_by = ${me}
  ))`;
}

/** Whether the quote exists in this tenant and is within `scope`. */
export async function quoteInScope(tenantId: string, id: string, scope: QuoteAccessScope): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({ id: quotes.id })
      .from(quotes)
      .leftJoin(deals, eq(deals.id, quotes.dealId))
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id), quoteAccessCondition(scope)))
      .limit(1),
  );
  return row !== undefined;
}

export async function listQuotesForDeal(
  tenantId: string,
  dealId: string,
  scope: QuoteAccessScope = {},
): Promise<QuoteListItem[]> {
  if (!isUuid(dealId)) return [];
  return tenantTransaction((tx) =>
    tx
      .select(listColumns)
      .from(quotes)
      .innerJoin(deals, eq(deals.id, quotes.dealId))
      .leftJoin(companies, eq(companies.id, deals.companyId))
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.dealId, dealId), quoteAccessCondition(scope)))
      .orderBy(desc(quotes.createdAt), desc(quotes.revision)),
  );
}

/** Every revision of one quote number (works for quotes with or without a deal). */
export async function listQuoteRevisions(
  tenantId: string,
  quoteNumber: string,
): Promise<Array<{ id: string; quoteNumber: string; revision: number }>> {
  return tenantTransaction((tx) =>
    tx
      .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, revision: quotes.revision })
      .from(quotes)
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.quoteNumber, quoteNumber)))
      .orderBy(desc(quotes.revision)),
  );
}

export type QuoteDealOption = {
  id: string;
  name: string;
  companyName: string | null;
  stage: string;
  amountMinor: number;
  currency: string;
  ownerName: string | null;
};

/**
 * Deals a quote can be linked to: live deals within `scope` whose name or
 * company matches `term`, most recently updated first.
 */
export async function searchDealsForQuote(
  tenantId: string,
  term: string,
  scope: QuoteDealScope = {},
  limit = 20,
): Promise<QuoteDealOption[]> {
  const q = term.trim().slice(0, 100);
  const where: (SQL | undefined)[] = [eq(deals.tenantId, tenantId), isNull(deals.deletedAt), dealScopeCondition(scope)];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${deals.name} ILIKE ${like} OR ${companies.name} ILIKE ${like} OR ${deals.companyNameText} ILIKE ${like})`);
  }
  return tenantTransaction((tx) =>
    tx
      .select({
        id: deals.id,
        name: deals.name,
        companyName: sql<string | null>`coalesce(${companies.name}, ${deals.companyNameText})`,
        stage: sql<string>`${deals.stage}::text`,
        amountMinor: deals.amountMinor,
        currency: deals.currency,
        ownerName: sql<string | null>`nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), '')`,
      })
      .from(deals)
      .leftJoin(companies, and(eq(companies.id, deals.companyId), isNull(companies.deletedAt)))
      .leftJoin(users, eq(users.id, deals.ownerId))
      .where(and(...where))
      .orderBy(desc(deals.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 50)),
  );
}

const cursorSchema = z.object({
  // created_at::text, e.g. '2026-11-20 10:11:12.123456+05:30'.
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2}){0,2}|Z)$/),
  id: z.uuid(),
});

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const isoDateSchema = z.iso.date();

/**
 * Tenant-wide quote list, newest first, keyset-paginated on
 * (created_at, id). `from` / `to` are inclusive ISO dates on quote_date.
 */
export async function listQuotes(
  tenantId: string,
  f: { status?: QuoteStatus; createdBy?: string; from?: string; to?: string; cursor?: string; limit?: number },
  scope: QuoteAccessScope = {},
): Promise<{ rows: QuoteListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
  const where: (SQL | undefined)[] = [eq(quotes.tenantId, tenantId), quoteAccessCondition(scope)];
  if (f.status) where.push(eq(quotes.status, f.status));
  if (f.createdBy) where.push(eq(quotes.createdBy, f.createdBy));
  if (f.from) where.push(gte(quotes.quoteDate, isoDateSchema.parse(f.from)));
  if (f.to) where.push(lte(quotes.quoteDate, isoDateSchema.parse(f.to)));
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    // An unparseable cursor is treated as the first page.
    if (c) where.push(sql`(${quotes.createdAt}, ${quotes.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
  }

  const rows = await tenantTransaction((tx) =>
    tx
      .select({ ...listColumns, cursorTs: sql<string>`${quotes.createdAt}::text` })
      .from(quotes)
      .leftJoin(deals, eq(deals.id, quotes.dealId))
      .leftJoin(companies, eq(companies.id, deals.companyId))
      .where(and(...where))
      .orderBy(desc(quotes.createdAt), desc(quotes.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ t: last.cursorTs, id: last.id }), 'utf8').toString('base64url')
      : null;
  return {
    rows: page.map((r) => {
      const item: QuoteListItem & { cursorTs?: string } = { ...r };
      delete item.cursorTs;
      return item;
    }),
    nextCursor,
  };
}

/* ------------------------------------------------------------ deal value */

/**
 * Set the deal's amount to the quote's taxable value (subtotal − discount),
 * through the same patch path as the inline deal editor so its rules, audit
 * log, triggers and realtime events apply. A refused patch throws
 * QuoteRuleError with the deal rule's message.
 */
export async function setDealAmountFromQuote(tenantId: string, userId: string, quoteId: string): Promise<void> {
  if (!isUuid(quoteId)) throw new QuoteNotFoundError();
  const [q] = await tenantTransaction((tx) =>
    tx
      .select({
        dealId: quotes.dealId,
        currency: quotes.currency,
        subtotalMinor: quotes.subtotalMinor,
        discountMinor: quotes.discountMinor,
        dealCurrency: deals.currency,
      })
      .from(quotes)
      .leftJoin(deals, eq(deals.id, quotes.dealId))
      .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, quoteId)))
      .limit(1),
  );
  if (!q) throw new QuoteNotFoundError();
  if (!q.dealId) throw new QuoteRuleError('This quote is not linked to a deal.');
  const taxableMinor = q.subtotalMinor - q.discountMinor;
  const result = await applyDealPatch(tenantId, userId, {
    id: q.dealId,
    // The patch input is in major units; INR has two decimals.
    amount: taxableMinor / 100,
    ...(q.dealCurrency !== q.currency ? { currency: q.currency as 'INR' } : {}),
  });
  if (!result.ok) throw new QuoteRuleError(result.message);
}
