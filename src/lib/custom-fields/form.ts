import {
  validateCustomFields,
  type CustomFieldDef,
  type CustomValues,
} from './types';

/**
 * Read custom-field values out of a submitted FormData (inputs are named
 * `cf_<key>`) and validate them against the active definitions. Shared by the
 * deal / company / contact create + update actions.
 */
export function parseCustomFieldsForm(
  defs: CustomFieldDef[],
  formData: FormData,
):
  | { ok: true; values: CustomValues }
  | { ok: false; errors: Record<string, string> } {
  const raw: CustomValues = {};
  for (const def of defs) {
    const name = `cf_${def.key}`;
    if (def.fieldType === 'boolean') {
      raw[def.key] = formData.get(name) != null;
    } else {
      const v = formData.get(name);
      raw[def.key] = typeof v === 'string' ? v : '';
    }
  }
  return validateCustomFields(defs, raw);
}

/** Map validation errors to form field-error shape (keyed by `cf_<key>`). */
export function customFieldFieldErrors(
  errors: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(errors).map(([k, m]) => [`cf_${k}`, [m]]),
  );
}
