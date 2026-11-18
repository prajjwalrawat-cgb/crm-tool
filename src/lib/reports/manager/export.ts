import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';

import { csvLine } from './csv-format';
import { closedWhere, createdWhere } from './facts';
import { ownerIn, type ReportScope } from './scope';
import { drill, repProductivity, slaReport, sourceRoiReport, staleLeads, DRILL_METRICS, type DrillMetric } from './services';
import type { ResolvedRange } from './time';

/**
 * Streaming CSV export, capped at 100k rows, audit-logged. Large lists
 * (leads created, won deals) are read in keyset pages of 5,000 so memory
 * stays flat however big the export; the smaller reports come from their
 * service. XLSX is not offered: no spreadsheet library is installed, and
 * CSV opens in Excel.
 */

export const EXPORT_ROW_CAP = 100_000;
const PAGE = 5_000;

export const EXPORT_REPORTS = ['rep-productivity', 'source-roi', 'stale-leads', 'sla-breaches', 'leads', 'won-deals', ...DRILL_METRICS.map((m) => `drill:${m}`)] as const;

type Row = Record<string, unknown>;

async function* keysetDeals(scope: ReportScope, range: ResolvedRange, kind: 'leads' | 'won-deals'): AsyncGenerator<Row[]> {
  const w = { tenantId: scope.tenantId, fromTs: range.fromTs, toTs: range.toTs, tz: range.tz };
  let after = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const where = kind === 'leads' ? createdWhere(w) : closedWhere(w, 'won');
    const rows = (await tenantTransaction((tx) =>
      tx.execute(sql`
        SELECT d.id, d.name, d.stage::text AS stage, d.owner_id, d.source, d.amount_minor / 100.0 AS value,
               d.currency, d.created_at, d.closed_at, d.lead_city, d.lead_state, d.utm_source, d.utm_campaign
        FROM deals d
        WHERE ${where} AND ${ownerIn(scope, sql`coalesce(d.owner_id, '')`)} AND d.id > ${after}::uuid
        ORDER BY d.id LIMIT ${PAGE}`),
    )) as unknown as Row[];
    if (rows.length === 0) return;
    total += rows.length;
    yield rows;
    after = String(rows[rows.length - 1]!.id);
    if (rows.length < PAGE || total >= EXPORT_ROW_CAP) return;
  }
}

async function* rowsFor(scope: ReportScope, report: string, range: ResolvedRange, params: Record<string, string>): AsyncGenerator<Row[]> {
  switch (report) {
    case 'leads':
    case 'won-deals':
      yield* keysetDeals(scope, range, report);
      return;
    case 'rep-productivity': {
      const r = await repProductivity(scope, range);
      yield r.rows.map((row) => {
        const out: Row = { ...row };
        delete out.bands;
        return out;
      });
      return;
    }
    case 'source-roi':
      yield (await sourceRoiReport(scope, range)).rows;
      return;
    case 'stale-leads':
      yield (await staleLeads(scope, Number(params.days ?? 7) || 7, params.ownerId ?? null, 2000)).rows;
      return;
    case 'sla-breaches':
      yield (await slaReport(scope, range)).breaches;
      return;
    default:
      if (report.startsWith('drill:')) {
        const m = report.slice(6);
        if ((DRILL_METRICS as readonly string[]).includes(m)) yield (await drill(scope, m as DrillMetric, range, 5000)).rows;
      }
  }
}

/**
 * A ReadableStream of CSV for `report`. The header is taken from the first
 * page's keys. The audit row is written when the stream finishes, with the
 * real row count.
 */
export function exportCsvStream(args: {
  scope: ReportScope;
  report: string;
  range: ResolvedRange;
  params: Record<string, string>;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let iter: AsyncGenerator<Row[]> | null = null;
  let header: string[] | null = null;
  let count = 0;
  let finished = false;
  const audit = () =>
    args.run(() =>
      tenantTransaction((tx) =>
        tx.execute(sql`
          INSERT INTO report_export_audit (tenant_id, user_id, report, format, params, row_count)
          VALUES (${args.scope.tenantId}::uuid, ${args.scope.viewerUserId}, ${args.report}, 'csv',
                  ${JSON.stringify({ ...args.params, from: args.range.fromDay, to: args.range.toDay })}::jsonb, ${count})`),
      ),
    );
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        iter ??= rowsFor(args.scope, args.report, args.range, args.params);
        const next = await args.run(() => iter!.next());
        if (next.done || count >= EXPORT_ROW_CAP) {
          if (!header) controller.enqueue(enc.encode('no rows\n'));
          if (!finished) {
            finished = true;
            await audit();
          }
          controller.close();
          return;
        }
        let rows = next.value;
        if (count + rows.length > EXPORT_ROW_CAP) rows = rows.slice(0, EXPORT_ROW_CAP - count);
        if (!header && rows.length) {
          header = Object.keys(rows[0]!);
          controller.enqueue(enc.encode(csvLine(header)));
        }
        let chunk = '';
        for (const r of rows) chunk += csvLine(header!.map((h) => r[h]));
        count += rows.length;
        controller.enqueue(enc.encode(chunk));
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
