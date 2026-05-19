import 'server-only';

/**
 * Minimal CSV serializer. Avoids a dependency for what's effectively
 * 30 lines of code. Handles the three escape cases that actually
 * matter (commas, quotes, newlines); we deliberately don't support
 * Excel BOM / locale-specific separators in v1.
 *
 * Caller passes a flat row shape `Record<string, string|number|null>`
 * and a column order. Returns a string ready to ship as a Response.
 */
export function rowsToCsv<R extends Record<string, unknown>>(
  rows: R[],
  columns: { key: keyof R; label: string }[],
): string {
  const header = columns.map((c) => escapeField(c.label)).join(',');
  const body = rows
    .map((row) =>
      columns.map((c) => escapeField(formatValue(row[c.key]))).join(','),
    )
    .join('\n');
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function escapeField(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
