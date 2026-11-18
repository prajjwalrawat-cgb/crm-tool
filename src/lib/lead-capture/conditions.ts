import type { RuleCondition } from '@/db/schema/lead-capture';

/**
 * Rule condition evaluation. Pure. A rule matches when ALL its conditions
 * match; an empty condition list matches every lead.
 *
 * Facts are flat: `source_id`, `source_type`, `city`, `state`,
 * `product_interest`, `company`, `email_domain`, `utm_source` …, plus
 * `custom.<key>` for custom fields. String comparison is case-insensitive and
 * trimmed.
 */
export type LeadFacts = Record<string, string | number | boolean | null | undefined>;

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function evaluateCondition(c: RuleCondition, facts: LeadFacts): boolean {
  const actual = facts[c.field];
  switch (c.op) {
    case 'exists':
      // value === false inverts: "field is missing".
      return c.value === false ? isBlank(actual) : !isBlank(actual);
    case 'eq':
      return !isBlank(actual) && norm(actual) === norm(c.value);
    case 'neq':
      return norm(actual) !== norm(c.value);
    case 'in': {
      const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',');
      return !isBlank(actual) && list.map(norm).includes(norm(actual));
    }
    case 'contains':
      return !isBlank(actual) && !isBlank(c.value) && norm(actual).includes(norm(c.value));
    case 'gt':
    case 'lt': {
      const a = toNumber(actual);
      const b = toNumber(c.value);
      if (a === null || b === null) return false;
      return c.op === 'gt' ? a > b : a < b;
    }
    default:
      return false;
  }
}

export function ruleMatches(conditions: RuleCondition[], facts: LeadFacts): boolean {
  return conditions.every((c) => evaluateCondition(c, facts));
}
