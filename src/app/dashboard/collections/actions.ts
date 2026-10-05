'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import {
  addInvoicePayment,
  approveDealCreditTerms,
  deleteInvoicePayment,
  getCollectionSettings,
  getDealCreditTerms,
  getInvoiceCollection,
  listInvoiceDealOptions,
  saveCollectionSettings,
  setDealCreditTerms,
  setInvoiceDeal,
  type DealOption,
  type InvoiceCollectionView,
} from '@/lib/collections/queries';
import { runWithTenantContext } from '@/lib/db-context';
import { toMinorUnits } from '@/lib/deals/currency';
import { isAdmin, requireMembership } from '@/lib/membership';
import { can } from '@/lib/rbac';
import { requireTenant } from '@/lib/tenant';

export type CollectionActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { value: T }))
  | { ok: false; message: string };

const days = z.coerce.number().int('Whole days only').min(0, 'Cannot be negative').max(730, 'At most 730 days');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a valid date');

function firstError(err: z.ZodError): string {
  const flat = z.flattenError(err);
  const field = Object.values(flat.fieldErrors)[0] as string[] | undefined;
  return flat.formErrors[0] ?? field?.[0] ?? 'Invalid input.';
}

const today = () => new Date().toISOString().slice(0, 10);

/** Tenant + membership + context, for actions whose rule is more than one permission. */
async function withMember<T>(fn: (ctx: { tenantId: string; userId: string; role: Awaited<ReturnType<typeof requireMembership>>['role'] }) => Promise<T>): Promise<T> {
  const tenant = await requireTenant();
  const membership = await requireMembership();
  return await runWithTenantContext({ tenantId: tenant.id, userId: membership.userId }, () =>
    fn({ tenantId: tenant.id, userId: membership.userId, role: membership.role }),
  );
}

function revalidateCollections(dealId?: string | null) {
  revalidatePath('/dashboard/collections');
  revalidatePath('/dashboard/invoices');
  if (dealId) revalidatePath(`/dashboard/deals/${dealId}`);
}

/* ------------------------------------------------------------------ *
 * Settings                                                            *
 * ------------------------------------------------------------------ */

export async function saveCollectionSettingsAction(input: unknown): Promise<CollectionActionResult> {
  const parsed = z.object({ standardCreditDays: days, materialExcessDays: days }).safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const gate = await checkPermission('manageCollectionSettings');
  if (!gate.ok) return { ok: false, message: gate.message };
  await runWithTenantContext({ tenantId: gate.tenant.id, userId: gate.membership.userId }, () =>
    saveCollectionSettings(gate.tenant.id, gate.membership.userId, parsed.data),
  );
  revalidateCollections();
  revalidatePath('/dashboard/settings/credit-terms');
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Deal credit terms                                                   *
 * ------------------------------------------------------------------ */

export async function setDealCreditTermsAction(
  input: unknown,
): Promise<CollectionActionResult<{ needsApproval: boolean; approved: boolean }>> {
  const parsed = z
    .object({ dealId: z.string().uuid(), days, note: z.string().trim().max(500).nullish() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  return await withMember(async ({ tenantId, userId, role }) => {
    // Same rule as every other deal field: anyone who can manage deals.
    if (!can(role, 'manageDeals')) return { ok: false as const, message: 'You can’t edit deals.' };
    const settings = await getCollectionSettings(tenantId);
    try {
      const res = await setDealCreditTerms({
        tenantId,
        dealId: parsed.data.dealId,
        actorId: userId,
        days: parsed.data.days,
        note: parsed.data.note || null,
        actorCanApprove: can(role, 'approveCreditTerms'),
        settings,
      });
      revalidateCollections(parsed.data.dealId);
      return { ok: true as const, value: res };
    } catch {
      return { ok: false as const, message: 'Deal not found.' };
    }
  });
}

export async function approveDealCreditTermsAction(input: unknown): Promise<CollectionActionResult> {
  const parsed = z.object({ dealId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const gate = await checkPermission('approveCreditTerms');
  if (!gate.ok) return { ok: false, message: gate.message };
  return await runWithTenantContext({ tenantId: gate.tenant.id, userId: gate.membership.userId }, async () => {
    const terms = await getDealCreditTerms(gate.tenant.id, parsed.data.dealId);
    if (!terms) return { ok: false as const, message: 'No credit terms recorded on this deal.' };
    await approveDealCreditTerms(gate.tenant.id, parsed.data.dealId, gate.membership.userId);
    revalidateCollections(parsed.data.dealId);
    return { ok: true as const };
  });
}

/* ------------------------------------------------------------------ *
 * Invoice collection                                                  *
 * ------------------------------------------------------------------ */

type InvoiceAccess = { view: boolean; editLink: boolean; recordPayments: boolean };

/**
 * Invoice list scoping is "your own PIs, or all if owner/admin". The
 * collection panel follows it, plus: whoever may record payments can open
 * any invoice to record one.
 */
function invoiceAccess(role: Parameters<typeof can>[0], userId: string, createdBy: string | null): InvoiceAccess {
  const admin = isAdmin({ role: role ?? 'viewer' });
  const own = createdBy === userId;
  const payments = can(role, 'recordPayments');
  return { view: admin || own || payments, editLink: admin || own, recordPayments: payments };
}

export type InvoiceCollectionPayload = InvoiceCollectionView & { access: InvoiceAccess };

export async function getInvoiceCollectionAction(invoiceId: string): Promise<CollectionActionResult<InvoiceCollectionPayload>> {
  if (!z.string().uuid().safeParse(invoiceId).success) return { ok: false, message: 'Invalid invoice.' };
  return await withMember(async ({ tenantId, userId, role }) => {
    const view = await getInvoiceCollection(tenantId, invoiceId, today());
    if (!view) return { ok: false as const, message: 'Invoice not found.' };
    const access = invoiceAccess(role, userId, view.createdBy);
    if (!access.view) return { ok: false as const, message: 'Invoice not found.' };
    return { ok: true as const, value: { ...view, access } };
  });
}

export async function listInvoiceDealOptionsAction(): Promise<CollectionActionResult<DealOption[]>> {
  return await withMember(async ({ tenantId, userId, role }) => {
    const all = isAdmin({ role: role ?? 'viewer' }) || can(role, 'recordPayments');
    return { ok: true as const, value: await listInvoiceDealOptions(tenantId, all ? undefined : userId) };
  });
}

export async function setInvoiceDealAction(input: unknown): Promise<CollectionActionResult> {
  const parsed = z
    .object({
      invoiceId: z.string().uuid(),
      dealId: z.string().uuid().nullable(),
      creditDays: z.union([days, z.null()]),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  return await withMember(async ({ tenantId, userId, role }) => {
    const view = await getInvoiceCollection(tenantId, parsed.data.invoiceId, today());
    if (!view || !invoiceAccess(role, userId, view.createdBy).editLink) {
      return { ok: false as const, message: 'You can only change invoices you created.' };
    }
    const res = await setInvoiceDeal({ tenantId, ...parsed.data });
    if (res === 'deal_not_found') return { ok: false as const, message: 'Deal not found.' };
    revalidateCollections(parsed.data.dealId ?? view.dealId);
    return { ok: true as const };
  });
}

export async function addInvoicePaymentAction(input: unknown): Promise<CollectionActionResult> {
  const parsed = z
    .object({
      invoiceId: z.string().uuid(),
      amount: z.coerce.number({ message: 'Enter an amount' }).positive('Amount must be more than 0').max(999_999_999_999),
      paidOn: isoDate,
      reference: z.string().trim().max(120).nullish(),
      note: z.string().trim().max(500).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  if (parsed.data.paidOn > today()) return { ok: false, message: 'Payment date can’t be in the future.' };
  const gate = await checkPermission('recordPayments');
  if (!gate.ok) return { ok: false, message: gate.message };
  return await runWithTenantContext({ tenantId: gate.tenant.id, userId: gate.membership.userId }, async () => {
    const view = await getInvoiceCollection(gate.tenant.id, parsed.data.invoiceId, today());
    if (!view) return { ok: false as const, message: 'Invoice not found.' };
    await addInvoicePayment({
      tenantId: gate.tenant.id,
      invoiceId: parsed.data.invoiceId,
      actorId: gate.membership.userId,
      amountMinor: toMinorUnits(parsed.data.amount, view.currency),
      paidOn: parsed.data.paidOn,
      reference: parsed.data.reference || null,
      note: parsed.data.note || null,
    });
    revalidateCollections(view.dealId);
    return { ok: true as const };
  });
}

export async function deleteInvoicePaymentAction(input: unknown): Promise<CollectionActionResult> {
  const parsed = z.object({ paymentId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: firstError(parsed.error) };
  const gate = await checkPermission('recordPayments');
  if (!gate.ok) return { ok: false, message: gate.message };
  return await runWithTenantContext({ tenantId: gate.tenant.id, userId: gate.membership.userId }, async () => {
    const invoiceId = await deleteInvoicePayment(gate.tenant.id, parsed.data.paymentId);
    if (!invoiceId) return { ok: false as const, message: 'Payment not found.' };
    revalidateCollections();
    return { ok: true as const };
  });
}
