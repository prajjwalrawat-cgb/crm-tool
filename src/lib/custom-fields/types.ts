/**
 * Client-safe custom-field types + validation. No `server-only` / DB imports
 * so forms can use these directly. The DB schema re-exports these constants so
 * Drizzle and the client share one source of truth.
 */
export const CUSTOM_FIELD_ENTITIES = ['deal', 'company', 'contact'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'boolean',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
};

export type CustomValues = Record<string, unknown>;

/** Normalize one raw form value to its stored shape (or return an error). */
export function coerceCustomValue(
  def: CustomFieldDef,
  raw: unknown,
): { value: unknown; error?: string } {
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (def.required && def.fieldType !== 'boolean') {
      return { value: null, error: `${def.label} is required` };
    }
    if (def.fieldType === 'boolean') return { value: false };
    return { value: null };
  }

  switch (def.fieldType) {
    case 'text':
      return { value: String(raw).trim().slice(0, 2000) };
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { value: null, error: `${def.label} must be a number` };
      }
      return { value: n };
    }
    case 'date': {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { value: null, error: `${def.label} must be a valid date` };
      }
      return { value: s };
    }
    case 'select': {
      const s = String(raw);
      if (!def.options.includes(s)) {
        return { value: null, error: `${def.label}: pick a valid option` };
      }
      return { value: s };
    }
    case 'boolean':
      return { value: raw === true || raw === 'true' || raw === 'on' || raw === '1' };
  }
}

/** Validate + normalize a whole values map against the active definitions. */
export function validateCustomFields(
  defs: CustomFieldDef[],
  raw: CustomValues,
):
  | { ok: true; values: CustomValues }
  | { ok: false; errors: Record<string, string> } {
  const values: CustomValues = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    const { value, error } = coerceCustomValue(def, raw[def.key]);
    if (error) {
      errors[def.key] = error;
    } else if (value !== null && value !== undefined) {
      values[def.key] = value;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values };
}

/** Human-readable rendering for a stored value (detail pages, tables). */
export function formatCustomValue(def: CustomFieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  switch (def.fieldType) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    default:
      return String(value);
  }
}

/** Slugify a label into a stable jsonb key. */
export function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}
