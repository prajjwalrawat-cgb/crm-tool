/**
 * Minimal RFC 4180 CSV parser for lead import. Pure. Handles quoted fields,
 * escaped quotes (""), CRLF/LF line endings, a UTF-8 BOM, and `;` or tab
 * delimiters (auto-detected from the header line). Blank lines are skipped.
 */

export type ParsedCsv = { headers: string[]; rows: Array<Record<string, string>> };

function detectDelimiter(firstLine: string): string {
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(text: string, maxRows = 10_000): ParsedCsv {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === delim) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((f) => f.trim() !== '')) records.push(record);
      record = [];
      if (records.length > maxRows) break;
    } else field += c;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (record.some((f) => f.trim() !== '')) records.push(record);
  }
  if (records.length === 0) return { headers: [], rows: [] };

  const seen = new Map<string, number>();
  const headers = records[0]!.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
  const rows = records.slice(1, maxRows + 1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim();
    });
    return o;
  });
  return { headers, rows };
}
