import 'server-only';

import crypto from 'node:crypto';

import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

import type { OrderProofAiRead } from '@/db/schema';
import { recordAiInvocation } from '@/lib/ai/audit';
import { aiLive, aiModeLabel } from '@/lib/ai/config';
import { AI_MODELS, getOpenAI } from '@/lib/ai/openai';

/**
 * Reading a client's PO / order confirmation with the AI (0071).
 *
 * The rep uploads the document; the model reads the order number, date,
 * buyer, currency and the values before and after tax, and the rep confirms
 * or corrects them before submitting. What the model read is SEALED (HMAC
 * over the reading and the file's hash) and handed back with the submit, so
 * the stored `ai_read` is provably the model's — a rep can correct a value,
 * but can't make it look as if the AI read their number.
 */

const SYSTEM = `You read purchase orders and other order confirmations (work orders, signed contracts, letters of intent, order emails) for a sales team.
Extract exactly what the document states. Use null for anything that is not printed on it — never guess.
- reference_no: the PO / order / contract number.
- issued_on: the document date, as YYYY-MM-DD.
- buyer_name: the company placing the order (the client), not the supplier.
- currency: ISO 4217 code (₹, Rs or INR → "INR"; $ → "USD" unless another dollar is stated).
- subtotal: the order value BEFORE taxes (GST, IGST, CGST, SGST, VAT, cess), after any discounts. If only a tax-inclusive total is printed and no tax breakdown, use null.
- tax: the total of all taxes, or null if not shown.
- total: the grand total payable including taxes.
Amounts are plain numbers in major units (12345.67), no separators or symbols.
confidence: "high" when the values are clearly printed, "medium" when you had to add up lines or the scan is unclear, "low" when this does not look like an order confirmation at all.
notes: one short sentence on anything the sales team should check (e.g. "Freight charged separately", "Document is a quotation, not a PO"), or null.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reference_no',
    'issued_on',
    'buyer_name',
    'currency',
    'subtotal',
    'tax',
    'total',
    'confidence',
    'notes',
  ],
  properties: {
    reference_no: { type: ['string', 'null'] },
    issued_on: { type: ['string', 'null'] },
    buyer_name: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    subtotal: { type: ['number', 'null'] },
    tax: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: ['string', 'null'] },
  },
} as const;

export type ExtractResult =
  | { ok: true; read: OrderProofAiRead; seal: string }
  | { ok: false; reason: 'ai_off' | 'failed'; message: string };

const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

function normalise(raw: Record<string, unknown>, model: string): OrderProofAiRead {
  const date = str(raw.issued_on, 10);
  const currency = str(raw.currency, 3)?.toUpperCase() ?? null;
  return {
    model,
    referenceNo: str(raw.reference_no, 120),
    issuedOn: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    buyerName: str(raw.buyer_name),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    subtotal: num(raw.subtotal),
    tax: num(raw.tax),
    total: num(raw.total),
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low',
    notes: str(raw.notes, 300),
  };
}

export function fileHash(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sealKey() {
  return `order-proof-read:v1:${process.env.AUTH_SECRET ?? ''}`;
}

function sealOf(read: OrderProofAiRead, hash: string) {
  return crypto
    .createHmac('sha256', sealKey())
    .update(`${hash}.${JSON.stringify(read)}`)
    .digest('base64url');
}

/** The AI's reading of this exact file, if `sealed` is genuinely one; otherwise null. */
export function openSealedRead(sealed: unknown, bytes: Uint8Array): OrderProofAiRead | null {
  if (typeof sealed !== 'string' || !sealed || sealed.length > 8000) return null;
  const dot = sealed.lastIndexOf('.');
  if (dot < 0) return null;
  let read: OrderProofAiRead;
  try {
    read = JSON.parse(Buffer.from(sealed.slice(0, dot), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const expected = Buffer.from(sealOf(read, fileHash(bytes)));
  const given = Buffer.from(sealed.slice(dot + 1));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
    ? read
    : null;
}

export async function extractOrderProof(input: {
  tenantId: string;
  actorUserId: string;
  dealId: string;
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}): Promise<ExtractResult> {
  if (!aiLive()) {
    return {
      ok: false,
      reason: 'ai_off',
      message: 'Automatic reading is off on this workspace — enter the PO details by hand.',
    };
  }
  const model = AI_MODELS.extract;
  const startedAt = Date.now();
  const dataUrl = `data:${input.contentType};base64,${Buffer.from(input.bytes).toString('base64')}`;
  const document: ChatCompletionContentPart =
    input.contentType === 'application/pdf'
      ? { type: 'file', file: { filename: input.fileName, file_data: dataUrl } }
      : { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } };

  try {
    const response = await getOpenAI().chat.completions.create({
      model,
      temperature: 0,
      user: input.tenantId,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Read this order confirmation.' }, document],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'order_confirmation', strict: true, schema: SCHEMA },
      },
    });
    const content = response.choices[0]?.message?.content ?? '';
    const read = normalise(JSON.parse(content) as Record<string, unknown>, model);
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'extract',
      model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      latencyMs: Date.now() - startedAt,
      status: 'success',
      metadata: { mode: aiModeLabel(), entity: 'deal', dealId: input.dealId, confidence: read.confidence },
    });
    const hash = fileHash(input.bytes);
    const body = Buffer.from(JSON.stringify(read)).toString('base64url');
    return { ok: true, read, seal: `${body}.${sealOf(read, hash)}` };
  } catch (err) {
    await recordAiInvocation({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: 'extract',
      model,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      metadata: { mode: aiModeLabel(), entity: 'deal', dealId: input.dealId },
    }).catch(() => {});
    return {
      ok: false,
      reason: 'failed',
      message: "Couldn't read this document automatically — enter the PO details by hand.",
    };
  }
}
