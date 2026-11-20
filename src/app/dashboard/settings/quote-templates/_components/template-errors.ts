/**
 * Maps template validation errors (dotted zod paths, as returned in
 * `fieldErrors` by saveQuoteTemplateAction) onto the builder: per section id
 * (via the `sections.<index>` path segment), theme, name, or general. Pure.
 */
import type { z } from 'zod';

export type TemplateErrors = {
  name: string[];
  theme: string[];
  /** Keyed by section id. */
  sections: Record<string, string[]>;
  general: string[];
};

export const NO_ERRORS: TemplateErrors = { name: [], theme: [], sections: {}, general: [] };

/** Same key format as the server action: issue path joined with '.', '_form' when empty. */
export function issuesToFieldErrors(issues: z.ZodError["issues"]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * `sectionIds` must be the section order the errors were produced against
 * (the order that was validated / sent to the server).
 */
export function groupTemplateErrors(
  fieldErrors: Record<string, string[]>,
  sectionIds: readonly string[],
): TemplateErrors {
  const out: TemplateErrors = { name: [], theme: [], sections: {}, general: [] };
  for (const [rawKey, messages] of Object.entries(fieldErrors)) {
    const key = rawKey.startsWith('body.') ? rawKey.slice('body.'.length) : rawKey;
    const parts = key.split('.');
    if (parts[0] === 'name') {
      out.name.push(...messages);
    } else if (parts[0] === 'theme') {
      const field = parts.slice(1).join('.');
      out.theme.push(...messages.map((m) => (field ? `${field}: ${m}` : m)));
    } else if (parts[0] === 'sections' && parts.length > 1 && /^\d+$/.test(parts[1])) {
      const id = sectionIds[Number(parts[1])];
      if (id === undefined) out.general.push(...messages);
      else (out.sections[id] ??= []).push(...messages);
    } else {
      out.general.push(...messages);
    }
  }
  return out;
}

export function mergeTemplateErrors(a: TemplateErrors, b: TemplateErrors): TemplateErrors {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const sections: Record<string, string[]> = { ...a.sections };
  for (const [id, msgs] of Object.entries(b.sections)) sections[id] = uniq([...(sections[id] ?? []), ...msgs]);
  return {
    name: uniq([...a.name, ...b.name]),
    theme: uniq([...a.theme, ...b.theme]),
    sections,
    general: uniq([...a.general, ...b.general]),
  };
}
