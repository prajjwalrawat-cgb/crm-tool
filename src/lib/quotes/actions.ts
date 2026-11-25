'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { logger } from '@/lib/observability/logger';
import { personaOf } from '@/lib/personas';
import type { MembershipRole } from '@/db/schema';
import { can, type Permission } from '@/lib/rbac';
import { deleteDealDocument, isStorageConfigured, uploadDealDocument } from '@/lib/storage/supabase';
import { requireTenant } from '@/lib/tenant';

import {
  QuoteFrozenError,
  QuoteNotFoundError,
  QuoteRuleError,
  archiveQuoteTemplate,
  createQuote,
  createQuoteRevision,
  duplicateQuoteTemplate,
  getQuote,
  quoteInScope,
  reapplyTemplate,
  saveQuoteSettings,
  saveQuoteTemplate,
  searchDealsForQuote,
  setQuoteDeal,
  type QuoteDealOption,
  type QuoteAccessScope,
  type QuoteDealScope,
  setDealAmountFromQuote,
  setDefaultQuoteTemplate,
  updateQuoteDraft,
} from './queries';
import type { QuoteRenderInput } from './pdf/context';
import { renderQuotePdfServer } from './pdf/render-server';
import { buildQuoteRenderInput } from './render-input';
import { quoteDraftInputSchema, quoteSettingsInputSchema } from './schema';
import { markQuoteSent, sendFailure, type SendDeps } from './send';
import type { QuoteDetail } from './types';

export type QuoteActionFailure = {
  ok: false;
  error: string;
  fieldErrors?: Record<string, string[]>;
};
export type QuoteActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | QuoteActionFailure;

const QUOTES_PATH = '/dashboard/quotes';
const TEMPLATES_PATH = '/dashboard/settings/quote-templates';
const dealPath = (dealId: string) => `/dashboard/deals/${dealId}`;
/**
 * Revalidate the quotes list and the quote's own page. Revalidating the page
 * the user is on sends it back refreshed in the action response, so the
 * client needs no router.refresh() (a second round trip; slow INP).
 */
function revalidateQuote(id: string): void {
  revalidatePath(QUOTES_PATH);
  revalidatePath(`${QUOTES_PATH}/${id}`);
}
/** Revalidate the deal page when the quote is linked to one. */
function revalidateDeal(dealId: string | null | undefined): void {
  if (dealId) revalidatePath(dealPath(dealId));
}

const idSchema = z.uuid();

const templateInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string(),
  body: z.unknown(),
});

function zodFailure(err: z.ZodError): QuoteActionFailure {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return {
    ok: false,
    error: err.issues[0]?.message ?? 'Please fix the highlighted fields.',
    fieldErrors,
  };
}

/** Domain errors become `{ ok:false }`; anything unexpected propagates. */
function toFailure(err: unknown): QuoteActionFailure {
  if (err instanceof z.ZodError) return zodFailure(err);
  if (
    err instanceof QuoteFrozenError ||
    err instanceof QuoteNotFoundError ||
    err instanceof QuoteRuleError
  ) {
    return { ok: false, error: err.message };
  }
  throw err;
}

/**
 * Shared gate: session -> tenant -> tenant context -> membership -> permissions
 * (ALL of `perms` must hold; `[]` = any member, viewers included).
 */
async function gated<T extends object>(
  perms: Permission[],
  fn: (ctx: { tenantId: string; userId: string; role: MembershipRole }) => Promise<QuoteActionResult<T>>,
): Promise<QuoteActionResult<T>> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };

  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }

  return runWithTenantContext({ tenantId, userId }, async (): Promise<QuoteActionResult<T>> => {
    let role;
    try {
      role = (await requireMembership()).role;
    } catch {
      return { ok: false, error: 'You are not a member of this workspace.' };
    }
    for (const perm of perms) {
      if (!can(role, perm)) {
        return { ok: false, error: 'You do not have permission to do that.' };
      }
    }
    try {
      return await fn({ tenantId, userId, role });
    } catch (err) {
      return toFailure(err);
    }
  });
}

/** Reps (sales persona) may link only deals they own or unassigned ones, as on the Deals page. */
function dealScopeFor(role: MembershipRole, userId: string): QuoteDealScope {
  return personaOf(role) === 'sales' ? { ownerOrUnassigned: userId } : {};
}

/** Reps (sales persona) see and act on only their own quotes; see QuoteAccessScope. */
function quoteScopeFor(role: MembershipRole, userId: string): QuoteAccessScope {
  return personaOf(role) === 'sales' ? { ownOnly: userId } : {};
}

/** Out-of-scope quotes look exactly like missing ones. */
async function requireQuoteAccess(tenantId: string, id: string, role: MembershipRole, userId: string): Promise<void> {
  const scope = quoteScopeFor(role, userId);
  if (scope.ownOnly && !(await quoteInScope(tenantId, id, scope))) throw new QuoteNotFoundError();
}

const invalidId = (what: string): QuoteActionFailure => ({ ok: false, error: `Invalid ${what}.` });

/* ------------------------------ templates ------------------------------ */

export async function saveQuoteTemplateAction(raw: unknown): Promise<QuoteActionResult<{ id: string }>> {
  const parsed = templateInputSchema.safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error);
  return gated(['manageQuoteTemplates'], async ({ tenantId, userId }) => {
    const { id } = await saveQuoteTemplate(tenantId, userId, parsed.data);
    revalidatePath(TEMPLATES_PATH);
    revalidatePath(`${TEMPLATES_PATH}/${id}`);
    return { ok: true, id };
  });
}

export async function duplicateQuoteTemplateAction(id: string): Promise<QuoteActionResult<{ id: string }>> {
  if (!idSchema.safeParse(id).success) return invalidId('template');
  return gated(['manageQuoteTemplates'], async ({ tenantId, userId }) => {
    const created = await duplicateQuoteTemplate(tenantId, userId, id);
    revalidatePath(TEMPLATES_PATH);
    return { ok: true, id: created.id };
  });
}

export async function setDefaultQuoteTemplateAction(id: string): Promise<QuoteActionResult> {
  if (!idSchema.safeParse(id).success) return invalidId('template');
  return gated(['manageQuoteTemplates'], async ({ tenantId }) => {
    await setDefaultQuoteTemplate(tenantId, id);
    revalidatePath(TEMPLATES_PATH);
    return { ok: true };
  });
}

export async function archiveQuoteTemplateAction(id: string): Promise<QuoteActionResult> {
  if (!idSchema.safeParse(id).success) return invalidId('template');
  return gated(['manageQuoteTemplates'], async ({ tenantId }) => {
    await archiveQuoteTemplate(tenantId, id);
    revalidatePath(TEMPLATES_PATH);
    return { ok: true };
  });
}

export async function saveQuoteSettingsAction(raw: unknown): Promise<QuoteActionResult> {
  const parsed = quoteSettingsInputSchema.safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error);
  return gated(['manageQuoteTemplates'], async ({ tenantId, userId }) => {
    await saveQuoteSettings(tenantId, userId, parsed.data);
    revalidatePath(TEMPLATES_PATH);
    return { ok: true };
  });
}

/* ------------------------------- quotes -------------------------------- */

/** New quote from the Quotes module; `dealId: null` = not linked to any deal. */
export async function createQuoteAction(raw: {
  dealId: string | null;
  templateId?: string;
}): Promise<QuoteActionResult<{ id: string }>> {
  const parsed = z
    .object({ dealId: z.uuid().nullable(), templateId: z.uuid().optional() })
    .safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error);
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    const { id } = await createQuote(tenantId, userId, parsed.data, dealScopeFor(role, userId));
    revalidatePath(QUOTES_PATH);
    revalidateDeal(parsed.data.dealId);
    return { ok: true, id };
  });
}

/** Deals the deal picker can link to, matched on deal or company name, within the user's deal scope. */
export async function searchDealsForQuoteAction(
  term: string,
): Promise<QuoteActionResult<{ deals: QuoteDealOption[] }>> {
  if (typeof term !== 'string') return { ok: false, error: 'Invalid search.' };
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    const deals = await searchDealsForQuote(tenantId, term, dealScopeFor(role, userId));
    return { ok: true, deals };
  });
}

/** Link a draft to a deal, change its deal, or unlink it (`dealId: null`). */
export async function setQuoteDealAction(id: string, dealId: string | null): Promise<QuoteActionResult> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  if (dealId !== null && !idSchema.safeParse(dealId).success) return invalidId('deal');
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    const { previousDealId } = await setQuoteDeal(tenantId, userId, id, dealId, dealScopeFor(role, userId));
    revalidateQuote(id);
    revalidateDeal(previousDealId);
    revalidateDeal(dealId);
    return { ok: true };
  });
}

export async function updateQuoteDraftAction(
  id: string,
  raw: unknown,
): Promise<QuoteActionResult<{ quote: QuoteDetail }>> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  const parsed = quoteDraftInputSchema.safeParse(raw);
  if (!parsed.success) return zodFailure(parsed.error);
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    const quote = await updateQuoteDraft(tenantId, userId, id, parsed.data);
    revalidateQuote(id);
    revalidateDeal(quote.dealId);
    return { ok: true, quote };
  });
}

export async function reapplyTemplateAction(id: string, templateId?: string): Promise<QuoteActionResult> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  if (templateId !== undefined && !idSchema.safeParse(templateId).success) return invalidId('template');
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    await reapplyTemplate(tenantId, userId, id, templateId);
    revalidateQuote(id);
    return { ok: true };
  });
}

export async function createQuoteRevisionAction(id: string): Promise<QuoteActionResult<{ id: string }>> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  return gated(['manageQuotes'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    const created = await createQuoteRevision(tenantId, userId, id);
    revalidatePath(QUOTES_PATH);
    const src = await getQuote(tenantId, id);
    revalidateDeal(src?.dealId);
    return { ok: true, id: created.id };
  });
}

/**
 * Changes the deal's amount, so it needs BOTH `manageQuotes` and `manageDeals`
 * (the inline deal editor's `patchDealAction` gates on `manageDeals`).
 */
export async function setDealAmountFromQuoteAction(id: string): Promise<QuoteActionResult> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  return gated(['manageQuotes', 'manageDeals'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    await setDealAmountFromQuote(tenantId, userId, id);
    revalidateQuote(id);
    const q = await getQuote(tenantId, id);
    revalidateDeal(q?.dealId);
    return { ok: true };
  });
}

/** Readable by any member (viewers included): the data the PDF is rendered from. */
export async function getQuoteForPdfAction(id: string): Promise<QuoteActionResult<{ input: QuoteRenderInput }>> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  return gated([], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    const input = await buildQuoteRenderInput(tenantId, id);
    if (!input) throw new QuoteNotFoundError();
    return { ok: true, input };
  });
}

/** Production send dependencies: the same render input as the browser download, Supabase storage. */
function serverSendDeps(tenantId: string): SendDeps {
  return {
    render: async (q) => {
      const input = await buildQuoteRenderInput(tenantId, q.id);
      if (!input) throw new QuoteNotFoundError();
      return renderQuotePdfServer(input);
    },
    upload: uploadDealDocument,
    removeUpload: deleteDealDocument,
  };
}

/** Render the PDF, file it on the deal as a proposal and lock the quote. */
export async function markQuoteSentAction(id: string): Promise<QuoteActionResult<{ documentId: string | null }>> {
  if (!idSchema.safeParse(id).success) return invalidId('quote');
  return gated<{ documentId: string | null }>(['manageQuotes'], async ({ tenantId, userId, role }) => {
    await requireQuoteAccess(tenantId, id, role, userId);
    // Only a quote linked to a deal files its PDF in storage.
    const pre = await getQuote(tenantId, id);
    if (pre?.dealId && !isStorageConfigured()) {
      return { ok: false, error: 'Document storage is not configured. Add SUPABASE_SERVICE_ROLE_KEY.' };
    }
    let documentId: string | null;
    try {
      ({ documentId } = await markQuoteSent(tenantId, userId, id, serverSendDeps(tenantId)));
    } catch (err) {
      const failure = sendFailure(err);
      if (failure.unexpected) {
        logger.error('quote send failed', {
          quoteId: id,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
      return { ok: false, error: failure.error };
    }
    revalidateQuote(id);
    const q = await getQuote(tenantId, id);
    revalidateDeal(q?.dealId);
    return { ok: true, documentId };
  });
}
