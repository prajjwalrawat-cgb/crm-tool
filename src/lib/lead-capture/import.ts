import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { leadImportJobs, leadSources } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { suggestColumnMapping, type MappingSuggestion } from './ai-mapping';
import { parseCsv } from './csv';
import { processIngestEvent, receiveIngestEvent } from './ingest';
import { canonicalRow, previewRows, type ImportColumnMapping } from './import-rows';
import { generateSourceSecret } from './signature';

/**
 * CSV lead import: preview → commit (job) → process in resumable chunks.
 *
 * Each row goes through the SAME ingest path as a webhook (stored as an
 * ingest event, deduped, created, distributed), so an imported lead is
 * indistinguishable from a captured one and re-importing the same file is a
 * no-op (identical rows hit the 24h replay window).
 */

export const IMPORT_MAX_ROWS = 10_000;
// Vercel caps a request body at 4.5 MB; stay under it with the action envelope.
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const IMPORT_CHUNK = 100;

export { canonicalRow, previewRows, type ImportColumnMapping };

export type ImportPreview = {
  headers: string[];
  totalRows: number;
  suggestion: MappingSuggestion;
  rows: Array<{ index: number; values: Record<string, string>; error: string | null }>;
  truncated: boolean;
};

export async function buildImportPreview(csvText: string): Promise<ImportPreview> {
  const parsed = parseCsv(csvText, IMPORT_MAX_ROWS);
  const suggestion = await suggestColumnMapping(parsed.headers);
  return {
    headers: parsed.headers,
    totalRows: parsed.rows.length,
    suggestion,
    rows: previewRows(parsed.rows, suggestion.mapping),
    truncated: parsed.rows.length >= IMPORT_MAX_ROWS,
  };
}

/** The workspace's CSV import source, created on first use. */
export async function ensureCsvImportSource(tenantId: string, createdBy: string): Promise<string> {
  return await tenantTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: leadSources.id })
      .from(leadSources)
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.type, 'csv_import'), eq(leadSources.isActive, true)))
      .limit(1);
    if (existing) return existing.id;
    const [row] = await tx
      .insert(leadSources)
      .values({ tenantId, name: 'CSV import', type: 'csv_import', secretToken: generateSourceSecret(), createdBy })
      .returning({ id: leadSources.id });
    return row!.id;
  });
}

export async function createImportJob(args: {
  tenantId: string;
  createdBy: string;
  sourceId: string;
  fileName: string | null;
  csvText: string;
  mapping: ImportColumnMapping;
}): Promise<{ jobId: string; total: number }> {
  const parsed = parseCsv(args.csvText, IMPORT_MAX_ROWS);
  const rows = parsed.rows.map((r) => canonicalRow(r, args.mapping)).filter((r) => Object.keys(r).length > 0);
  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(leadImportJobs)
      .values({
        tenantId: args.tenantId,
        sourceId: args.sourceId,
        createdBy: args.createdBy,
        fileName: args.fileName,
        mapping: Object.fromEntries(Object.entries(args.mapping).filter(([, v]) => v)) as Record<string, string>,
        rows,
        total: rows.length,
      })
      .returning({ id: leadImportJobs.id }),
  );
  return { jobId: row!.id, total: rows.length };
}

/**
 * Process the next chunk of a job. Returns created deal ids (for
 * distribution) and whether the job is finished. Safe to re-run: progress is
 * the `processed` cursor, and a row re-processed after a crash is a replay
 * (same payload, same source) that creates nothing.
 */
export async function processImportChunk(tenantId: string, jobId: string): Promise<{ done: boolean; createdDealIds: string[] }> {
  const [job] = await tenantTransaction((tx) =>
    tx
      .select({
        sourceId: leadImportJobs.sourceId,
        status: leadImportJobs.status,
        processed: leadImportJobs.processed,
        total: leadImportJobs.total,
        chunk: sql<Array<Record<string, string>>>`
          (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
             select e from jsonb_array_elements(${leadImportJobs.rows}) with ordinality as t(e, n)
             where n > ${leadImportJobs.processed} and n <= ${leadImportJobs.processed} + ${IMPORT_CHUNK}
             order by n) s)`,
      })
      .from(leadImportJobs)
      .where(and(eq(leadImportJobs.tenantId, tenantId), eq(leadImportJobs.id, jobId))),
  );
  if (!job || job.status === 'done' || job.status === 'failed') return { done: true, createdDealIds: [] };

  const created: string[] = [];
  let dup = 0;
  let failed = 0;
  const errors: Array<{ row: number; error: string }> = [];
  for (const [i, payload] of (job.chunk ?? []).entries()) {
    const rowNo = job.processed + i + 1;
    try {
      const { eventId } = await receiveIngestEvent({ tenantId, sourceId: job.sourceId, payload });
      const out = await processIngestEvent(eventId);
      if (out.status === 'created') created.push(out.dealId);
      else if (out.status === 'duplicate') dup++;
      else if (out.status === 'failed') {
        failed++;
        errors.push({ row: rowNo, error: out.error });
      }
    } catch (err) {
      failed++;
      errors.push({ row: rowNo, error: err instanceof Error ? err.message.slice(0, 200) : 'error' });
    }
  }
  const processed = Math.min(job.processed + (job.chunk?.length ?? 0), job.total);
  const done = processed >= job.total;
  await tenantTransaction((tx) =>
    tx
      .update(leadImportJobs)
      .set({
        status: done ? 'done' : 'running',
        processed,
        createdCount: sql`${leadImportJobs.createdCount} + ${created.length}`,
        duplicateCount: sql`${leadImportJobs.duplicateCount} + ${dup}`,
        failedCount: sql`${leadImportJobs.failedCount} + ${failed}`,
        // Keep the first 200 row errors; enough to fix a file.
        errors: sql`(select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select x from jsonb_array_elements(${leadImportJobs.errors} || ${JSON.stringify(errors)}::jsonb) x limit 200) s)`,
        // Rows are dropped once finished; the ingest events keep the payloads.
        ...(done ? { finishedAt: new Date(), rows: [] } : {}),
      })
      .where(eq(leadImportJobs.id, jobId)),
  );
  return { done, createdDealIds: created };
}
