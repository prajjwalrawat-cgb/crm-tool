import 'server-only';

import crypto from 'node:crypto';

import { extractTextItems } from 'unpdf';

import { parseOrderText, type TextLine } from './parse';
import type { OrderProofAiRead } from './types';

/**
 * Reading a client's PO on upload (0071), entirely on this server: the PDF's
 * own text is laid out into lines and columns and the values are found by
 * their labels (parse.ts). Nothing is sent to any outside service.
 *
 * A scanned PDF or a photo has no text to read; the rep types the details in.
 *
 * What was read is SEALED (HMAC over the reading and the file's hash) and
 * handed back with the submit, so the stored reading is provably the
 * reader's — a rep can correct a value, but can't make it look as if the
 * document said their number.
 */

const MAX_PAGES = 5;

export type ReadResult =
  | { ok: true; read: OrderProofAiRead; seal: string }
  | { ok: false; message: string };

/** The PDF's text as lines (top to bottom) of segments (left to right). */
async function textLines(bytes: Uint8Array): Promise<TextLine[]> {
  // pdf.js takes ownership of the buffer it is given; read from a copy.
  const { items } = await extractTextItems(new Uint8Array(bytes));
  const lines: TextLine[] = [];
  for (const page of items.slice(0, MAX_PAGES)) {
    const rows: Array<{ y: number; size: number; items: typeof page }> = [];
    for (const item of page) {
      if (!item.str.trim()) continue;
      const row = rows.find((r) => Math.abs(r.y - item.y) <= Math.max(2, r.size * 0.4));
      if (row) row.items.push(item);
      else rows.push({ y: item.y, size: item.fontSize || 10, items: [item] });
    }
    // PDF y runs bottom-up: the top of the page is the largest y.
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      const segments: TextLine['segments'] = [];
      let end = -Infinity;
      for (const item of row.items) {
        const gap = item.x - end;
        const last = segments[segments.length - 1];
        if (last && gap < Math.max(12, (item.fontSize || 10) * 1.5)) {
          last.text += gap > 1 ? ` ${item.str}` : item.str;
        } else {
          segments.push({ x: item.x, text: item.str });
        }
        end = item.x + item.width;
      }
      lines.push({ segments: segments.map((s) => ({ x: s.x, text: s.text.replace(/\s+/g, ' ').trim() })) });
    }
  }
  return lines;
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

/** The reading of this exact file, if `sealed` is genuinely one; otherwise null. */
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

export async function readOrderProof(input: {
  bytes: Uint8Array;
  contentType: string;
}): Promise<ReadResult> {
  if (input.contentType !== 'application/pdf') {
    return { ok: false, message: 'Images aren’t read automatically — enter the details as printed on the PO.' };
  }
  let lines: TextLine[];
  try {
    lines = await textLines(input.bytes);
  } catch (err) {
    console.error('[order-proofs] could not read PDF text:', err);
    return { ok: false, message: 'Couldn’t read this PDF — enter the details as printed on the PO.' };
  }
  if (lines.length === 0) {
    return {
      ok: false,
      message: 'This PDF is a scan with no text in it — enter the details as printed on the PO.',
    };
  }
  const read = parseOrderText(lines);
  if (read.referenceNo == null && read.subtotal == null && read.total == null) {
    return { ok: false, message: 'Couldn’t find the PO number or values in this PDF — enter them as printed.' };
  }
  const body = Buffer.from(JSON.stringify(read)).toString('base64url');
  return { ok: true, read, seal: `${body}.${sealOf(read, fileHash(input.bytes))}` };
}
