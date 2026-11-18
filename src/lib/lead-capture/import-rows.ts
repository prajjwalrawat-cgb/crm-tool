import { applyFieldMapping, validateMappedLead, type LeadFieldKey } from './mapping';

/** Pure CSV-row helpers for lead import (no I/O). */

export const PREVIEW_ROWS = 20;

export type ImportColumnMapping = Record<string, LeadFieldKey | null>;

/** Rewrite a CSV row to canonical lead keys using the chosen column mapping. */
export function canonicalRow(row: Record<string, string>, mapping: ImportColumnMapping): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [header, key] of Object.entries(mapping)) {
    const v = row[header];
    if (key && v !== undefined && v !== '') out[key] = v;
  }
  return out;
}

export function previewRows(rows: Array<Record<string, string>>, mapping: ImportColumnMapping) {
  return rows.slice(0, PREVIEW_ROWS).map((r, i) => {
    const lead = applyFieldMapping(canonicalRow(r, mapping));
    return { index: i + 1, values: r, error: validateMappedLead(lead) };
  });
}

