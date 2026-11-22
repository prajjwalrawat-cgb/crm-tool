import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { prospectImports } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { captureError } from '@/lib/observability';
import { can } from '@/lib/rbac';
import { isStorageConfigured, prospectImportsBucket, uploadPrivateFile } from '@/lib/storage/supabase';

import { insertProspectRows, MESSAGES, UUID_RE } from '../mutations';
import { normalizeProspectInput, prospectInputSchema, type Actor, type ProspectRowValues } from '../rules';
import { computeDedupHints, type DedupHint } from './dedup-hints';
import {
  MAX_DUMP_CHARS,
  MAX_DUMP_ROWS,
  parseDumpCsv,
  parseDumpImage,
  parseDumpText,
  type DumpImageMediaType,
  type DumpRow,
  type ParseDeps,
  type ParseOutcome,
} from './parse';

export type { DedupHint } from './dedup-hints';

/**
 * Quick Dump imports: parse a dump into a `prospect_imports` row for review,
 * then confirm (insert the reviewed rows as prospects, all or nothing) or
 * discard it. Nothing reaches `prospects` until a person confirms.
 */

export const MAX_SOURCE_TAG = 80;
export const MAX_CSV_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, { type: DumpImageMediaType; ext: string }> = {
  'image/png': { type: 'image/png', ext: 'png' },
  'image/jpeg': { type: 'image/jpeg', ext: 'jpg' },
  'image/jpg': { type: 'image/jpeg', ext: 'jpg' },
  'image/webp': { type: 'image/webp', ext: 'webp' },
  'image/gif': { type: 'image/gif', ext: 'gif' },
};

export const IMPORT_MESSAGES = {
  sourceTag: `Add a source tag (up to ${MAX_SOURCE_TAG} characters).`,
  kind: 'Choose text, CSV or image.',
  emptyText: 'Paste something to read first.',
  textTooLong: `This dump is too long. Keep it under ${MAX_DUMP_CHARS.toLocaleString('en-IN')} characters, or split it into parts.`,
  noFile: 'Choose a file to upload.',
  csvTooLarge: 'This CSV is larger than 4 MB. Split it into smaller files.',
  imageTooLarge: 'This image is larger than 5 MB. Use a smaller photo.',
  imageType: 'Use a PNG, JPEG, WebP or GIF image.',
  notFound: 'Import not found.',
  alreadyDone: 'This import was already confirmed or discarded.',
  noRows: 'Select at least one row to add.',
  tooManyRows: `An import can add at most ${MAX_DUMP_ROWS} rows.`,
  invalidRows: 'Some rows need fixing before they can be added.',
} as const;

export type ImportDeps = ParseDeps & {
  /** Storage seam (selftests): defaults to uploadPrivateFile when storage is configured. */
  upload?: (bucket: string, path: string, bytes: Uint8Array, contentType: string) => Promise<string>;
};

export type CreateImportInput = {
  sourceTag: string;
  kind: 'text' | 'csv' | 'image';
  text?: string;
  file?: { bytes: Buffer; mediaType: string; name: string };
};

/** HTTP status the route maps a failure to. */
export type ImportFailureStatus = 400 | 403 | 413 | 422 | 502;

export type CreateImportResult =
  | { ok: true; importId: string; rows: DumpRow[]; dropped: number; hints: DedupHint[] }
  | { ok: false; message: string; status: ImportFailureStatus };

const reject = (message: string, status: ImportFailureStatus): CreateImportResult => ({ ok: false, message, status });

/** AI-side failures (busy, API error, not configured) are 502; problems with the dump itself are 422. */
function parseFailureStatus(outcome: Extract<ParseOutcome, { ok: false }>): ImportFailureStatus {
  return outcome.retryable || /^AI parsing/.test(outcome.error) ? 502 : 422;
}

export async function createImport(
  tenantId: string,
  actor: Actor,
  input: CreateImportInput,
  deps: ImportDeps = {},
): Promise<CreateImportResult> {
  if (!can(actor.role, 'manageProspects')) return reject(MESSAGES.no_permission, 403);
  const sourceTag = typeof input.sourceTag === 'string' ? input.sourceTag.trim() : '';
  if (!sourceTag || sourceTag.length > MAX_SOURCE_TAG) return reject(IMPORT_MESSAGES.sourceTag, 400);

  let rawText: string | null = null;
  let parse: () => Promise<ParseOutcome>;
  let image: { bytes: Buffer; type: DumpImageMediaType; ext: string } | null = null;

  switch (input.kind) {
    case 'text': {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) return reject(IMPORT_MESSAGES.emptyText, 400);
      if (text.length > MAX_DUMP_CHARS) return reject(IMPORT_MESSAGES.textTooLong, 413);
      rawText = text;
      parse = () => parseDumpText(text, deps);
      break;
    }
    case 'csv': {
      let csv: string;
      if (input.file) {
        if (input.file.bytes.length > MAX_CSV_BYTES) return reject(IMPORT_MESSAGES.csvTooLarge, 413);
        csv = input.file.bytes.toString('utf8').replace(/^﻿/, '');
      } else if (typeof input.text === 'string') {
        if (Buffer.byteLength(input.text, 'utf8') > MAX_CSV_BYTES) return reject(IMPORT_MESSAGES.csvTooLarge, 413);
        csv = input.text;
      } else {
        return reject(IMPORT_MESSAGES.noFile, 400);
      }
      if (!csv.trim()) return reject(IMPORT_MESSAGES.noFile, 400);
      rawText = csv;
      parse = () => parseDumpCsv(csv, deps);
      break;
    }
    case 'image': {
      const f = input.file;
      if (!f || f.bytes.length === 0) return reject(IMPORT_MESSAGES.noFile, 400);
      if (f.bytes.length > MAX_IMAGE_BYTES) return reject(IMPORT_MESSAGES.imageTooLarge, 413);
      const t = IMAGE_TYPES[(f.mediaType ?? '').toLowerCase()];
      if (!t) return reject(IMPORT_MESSAGES.imageType, 400);
      image = { bytes: f.bytes, type: t.type, ext: t.ext };
      const img = image;
      parse = () => parseDumpImage(img.bytes, img.type, deps);
      break;
    }
    default:
      return reject(IMPORT_MESSAGES.kind, 400);
  }

  // Images: keep the original in the private bucket when storage is set up.
  // A failed upload is logged and the dump is still read (raw_file_path null).
  let rawFilePath: string | null = null;
  const upload = deps.upload ?? (isStorageConfigured() ? uploadPrivateFile : null);
  if (image && upload) {
    try {
      rawFilePath = await upload(prospectImportsBucket(), `${tenantId}/${randomUUID()}.${image.ext}`, image.bytes, image.type);
    } catch (err) {
      captureError(err, { category: 'prospects.import.upload_failed', severity: 'low' });
      rawFilePath = null;
    }
  }

  const outcome = await parse();
  const base = { tenantId, sourceTag, inputKind: input.kind, rawText, rawFilePath, createdBy: actor.userId };

  if (!outcome.ok) {
    await tenantTransaction((tx) =>
      tx.insert(prospectImports).values({ ...base, status: 'failed', error: outcome.error, rowsParsed: 0 }),
    );
    return reject(outcome.error, parseFailureStatus(outcome));
  }

  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(prospectImports)
      .values({
        ...base,
        status: 'parsed',
        parserModel: outcome.model,
        parserOutput: outcome.rows,
        rowsParsed: outcome.rows.length,
      })
      .returning({ id: prospectImports.id }),
  );

  let hints: DedupHint[] = [];
  try {
    hints = await computeDedupHints(tenantId, outcome.rows);
  } catch (err) {
    // Hints are informational: a failure must not lose the parsed import.
    captureError(err, { category: 'prospects.import.hints_failed', severity: 'low' });
  }

  return { ok: true, importId: row!.id, rows: outcome.rows, dropped: outcome.dropped, hints };
}

export type ConfirmImportResult =
  | { ok: true; inserted: number }
  | { ok: false; message: string; rowErrors?: { index: number; message: string }[] };

function issueMessage(issues: { path: PropertyKey[]; message: string }[]): string {
  const first = issues[0];
  if (!first) return 'Invalid row.';
  const field = first.path.map(String).join('.');
  return field ? `${field}: ${first.message}` : first.message;
}

export async function confirmImport(
  tenantId: string,
  actor: Actor,
  importId: string,
  rows: unknown[],
): Promise<ConfirmImportResult> {
  if (!can(actor.role, 'manageProspects')) return { ok: false, message: MESSAGES.no_permission };
  if (typeof importId !== 'string' || !UUID_RE.test(importId)) return { ok: false, message: IMPORT_MESSAGES.notFound };
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: IMPORT_MESSAGES.noRows };
  if (rows.length > MAX_DUMP_ROWS) return { ok: false, message: IMPORT_MESSAGES.tooManyRows };

  return tenantTransaction(async (tx): Promise<ConfirmImportResult> => {
    const [cur] = await tx
      .select({ id: prospectImports.id, status: prospectImports.status, sourceTag: prospectImports.sourceTag })
      .from(prospectImports)
      .where(and(eq(prospectImports.tenantId, tenantId), eq(prospectImports.id, importId)))
      .limit(1)
      .for('update');
    if (!cur) return { ok: false, message: IMPORT_MESSAGES.notFound };
    if (cur.status !== 'parsed') return { ok: false, message: IMPORT_MESSAGES.alreadyDone };

    const values: ProspectRowValues[] = [];
    const rowErrors: { index: number; message: string }[] = [];
    rows.forEach((r, index) => {
      const obj = r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
      if (!obj) {
        rowErrors.push({ index, message: 'Invalid row.' });
        return;
      }
      // The import's source tag always wins over anything in the row.
      const parsed = prospectInputSchema.safeParse({ ...obj, sourceTag: cur.sourceTag });
      if (!parsed.success) rowErrors.push({ index, message: issueMessage(parsed.error.issues) });
      else values.push(normalizeProspectInput(parsed.data));
    });
    if (rowErrors.length > 0) return { ok: false, message: IMPORT_MESSAGES.invalidRows, rowErrors };

    const ids = await insertProspectRows(tx, tenantId, actor, values, { importId });
    await tx
      .update(prospectImports)
      .set({ status: 'confirmed', rowsInserted: ids.length, confirmedAt: new Date() })
      .where(and(eq(prospectImports.tenantId, tenantId), eq(prospectImports.id, importId)));
    return { ok: true, inserted: ids.length };
  });
}

export async function discardImport(
  tenantId: string,
  actor: Actor,
  importId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!can(actor.role, 'manageProspects')) return { ok: false, message: MESSAGES.no_permission };
  if (typeof importId !== 'string' || !UUID_RE.test(importId)) return { ok: false, message: IMPORT_MESSAGES.notFound };
  return tenantTransaction(async (tx) => {
    const [cur] = await tx
      .select({ status: prospectImports.status })
      .from(prospectImports)
      .where(and(eq(prospectImports.tenantId, tenantId), eq(prospectImports.id, importId)))
      .limit(1)
      .for('update');
    if (!cur) return { ok: false as const, message: IMPORT_MESSAGES.notFound };
    if (cur.status !== 'parsed') return { ok: false as const, message: IMPORT_MESSAGES.alreadyDone };
    await tx
      .update(prospectImports)
      .set({ status: 'discarded' })
      .where(and(eq(prospectImports.tenantId, tenantId), eq(prospectImports.id, importId)));
    return { ok: true as const };
  });
}
